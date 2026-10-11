const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || process.env.QUIZ_PORT || 8787);
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
const DATA_DIR = process.env.QUIZ_DATA_DIR ? path.resolve(process.env.QUIZ_DATA_DIR) : path.join(ROOT, '.quiz-data');
const DATA_FILE = path.join(DATA_DIR, 'rooms.json');
const ROOM_TTL_MS = 18 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 1_000_000;
const MAX_QUESTIONS = 120;
const MAX_OPTIONS = 8;
const MAX_TEXT = 800;

const rooms = new Map();

function send(res, status, data, type = 'application/json; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders
  });
  if (res.req?.method === 'HEAD') return res.end();
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}

function sendError(res, status, message) {
  return send(res, status, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        tooLarge = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooLarge) return reject(Object.assign(new Error('Request too large.'), { status: 413 }));
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        reject(Object.assign(new Error('Invalid JSON.'), { status: 400 }));
      }
    });
    req.on('error', () => {
      reject(Object.assign(new Error(tooLarge ? 'Request too large.' : 'Request failed.'), { status: tooLarge ? 413 : 400 }));
    });
  });
}

function ips() {
  return [...new Set(Object.values(os.networkInterfaces())
    .flat()
    .filter(x => x && x.family === 'IPv4' && !x.internal)
    .map(x => x.address))]
    .sort((a, b) => {
      const priority = value => value.startsWith('192.168.') ? 0 : value.startsWith('10.') ? 1 : value.startsWith('172.') ? 2 : 3;
      return priority(a) - priority(b);
    });
}

function requestBaseUrls(req) {
  const forwardedProto = safeText(req.headers['x-forwarded-proto'], '', 20).split(',')[0];
  const protocol = forwardedProto === 'https' ? 'https' : 'http';
  const host = safeText(req.headers['x-forwarded-host'] || req.headers.host, '', 260).split(',')[0];
  const hostName = host.replace(/:\d+$/, '');
  const localRequest = /^(localhost|127\.0\.0\.1)$/i.test(hostName);
  const privateRequest = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostName);
  const urls = [];
  if (PUBLIC_BASE_URL) urls.push(PUBLIC_BASE_URL);
  if (host && !localRequest) urls.push(`${protocol}://${host}`);
  if (!PUBLIC_BASE_URL && (localRequest || privateRequest)) {
    for (const ip of ips()) urls.push(`http://${ip}:${PORT}`);
  }
  if (host) urls.push(`${protocol}://${host}`);
  if (localRequest || privateRequest) urls.push(`http://localhost:${PORT}`);
  return [...new Set(urls)];
}

function joinUrls(req, roomId) {
  return requestBaseUrls(req).map(base => `${base}/live.html?room=${encodeURIComponent(roomId)}`);
}

function safeText(value, fallback = '', max = MAX_TEXT) {
  const text = String(value ?? fallback).replace(/\s+/g, ' ').trim();
  return text.slice(0, max) || fallback;
}

function normalize(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeKind(kind) {
  return ['mcq', 'poll', 'guess', 'debate'].includes(kind) ? kind : 'mcq';
}

function sanitizeQuestion(input, index) {
  const kind = normalizeKind(input?.kind || 'mcq');
  const round = safeText(input?.round, 'Round 1', 120);
  const q = safeText(input?.q, `Question ${index + 1}`, MAX_TEXT);
  const rawOptions = Array.isArray(input?.o) ? input.o : [];
  const options = rawOptions
    .map(option => safeText(option, '', 220))
    .filter(Boolean)
    .slice(0, MAX_OPTIONS);

  if (kind === 'guess') {
    return {
      round,
      q,
      o: [],
      a: safeText(input?.a, '', 220),
      kind,
      note: safeText(input?.note, '', 300),
      hostNote: safeText(input?.hostNote, '', 500)
    };
  }

  if (kind === 'debate') {
    return { round, q, o: [], a: -1, kind, hostNote: safeText(input?.hostNote, '', 500) };
  }

  while (options.length < 2) options.push(`Choice ${options.length + 1}`);
  if (kind === 'poll') {
    return { round, q, o: options, a: -1, kind, hostNote: safeText(input?.hostNote, '', 500) };
  }

  const answer = Number(input?.a);
  return {
    round,
    q,
    o: options,
    a: Number.isInteger(answer) && answer >= 0 && answer < options.length ? answer : 0,
    kind: 'mcq',
    hostNote: safeText(input?.hostNote, '', 500)
  };
}

function sanitizeQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw Object.assign(new Error('No quiz questions supplied.'), { status: 400 });
  }

  const cleaned = questions.slice(0, MAX_QUESTIONS).map(sanitizeQuestion);
  const rounds = [...new Set(cleaned.map(question => question.round))];
  return rounds.flatMap(round => cleaned.filter(question => question.round === round && question.kind !== 'debate')
    .concat(cleaned.filter(question => question.round === round && question.kind === 'debate')));
}

function questionKey(room) {
  return `${room.roundIndex}:${room.position}`;
}

function currentIndices(room) {
  const round = room.rounds[room.roundIndex];
  if (!round) return [];
  return room.questions.map((q, i) => q.round === round ? i : -1).filter(i => i >= 0);
}

function currentQuestion(room) {
  const indices = currentIndices(room);
  const index = indices[room.position];
  return index === undefined ? null : room.questions[index];
}

function rememberSession(room) {
  if (room.active) {
    room.active.questionKey = questionKey(room);
    room.sessions[questionKey(room)] = room.active;
  }
}

function restoreSession(room) {
  room.active = room.sessions[questionKey(room)] || null;
}

function touchRoom(room, shouldPersist = true) {
  room.updatedAt = Date.now();
  room.version = (room.version || 0) + 1;
  if (shouldPersist) persistRooms();
}

function serializableRooms() {
  const cutoff = Date.now() - ROOM_TTL_MS;
  return [...rooms.values()].filter(room => room.updatedAt >= cutoff);
}

function persistRooms() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(serializableRooms(), null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function loadRooms() {
  if (!fs.existsSync(DATA_FILE)) return;
  try {
    const stored = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const cutoff = Date.now() - ROOM_TTL_MS;
    for (const room of Array.isArray(stored) ? stored : []) {
      if (!room?.id || !Array.isArray(room.questions) || room.updatedAt < cutoff) continue;
      room.sessions = room.sessions && typeof room.sessions === 'object' ? room.sessions : {};
      room.started = room.started === true;
      room.version = Number(room.version) || 1;
      room.updatedAt = Number(room.updatedAt) || Date.now();
      rooms.set(room.id, room);
    }
  } catch (error) {
    console.warn(`Could not load saved quiz rooms: ${error.message}`);
  }
}

function pruneRooms() {
  const cutoff = Date.now() - ROOM_TTL_MS;
  let changed = false;
  for (const [id, room] of rooms.entries()) {
    if (room.updatedAt < cutoff) {
      rooms.delete(id);
      changed = true;
    }
  }
  if (changed) persistRooms();
}

function findRoom(id) {
  const normalizedId = safeText(id, '', 24).toUpperCase();
  return normalizedId ? rooms.get(normalizedId) || null : null;
}

function requireRoom(id) {
  const room = findRoom(id);
  if (!room) throw Object.assign(new Error('Quiz room not found.'), { status: 404 });
  return room;
}

function requireHost(room, token) {
  if (!room.hostToken || token !== room.hostToken) {
    throw Object.assign(new Error('Host control key is missing or invalid.'), { status: 403 });
  }
}

function closeExpiredVote(room) {
  if (room.active?.open && Date.now() >= room.active.endsAt) {
    room.active.open = false;
    rememberSession(room);
    touchRoom(room);
  }
}

function publicQuestion(question, stage) {
  if (!question) return null;
  const payload = {
    q: question.q,
    o: question.o || [],
    kind: question.kind || 'mcq'
  };
  if (stage === 'results' && question.note) payload.note = question.note;
  return payload;
}

function recapFor(room) {
  const lastRound = room.recapRoundIndex ?? room.roundIndex;
  const firstRound = Math.max(0, lastRound - 1);
  return [firstRound, lastRound].map(roundIndex => {
    const round = room.rounds[roundIndex];
    const questions = room.questions.filter(question => question.round === round);
    let totalCorrect = 0, totalResponses = 0;
    const questionStats = questions.map((question, position) => {
      const session = room.sessions[`${roundIndex}:${position}`];
      if (!session || session.open || session.skipped || !['mcq', 'guess'].includes(question.kind || 'mcq')) return null;
      const votes = Object.values(session.votes || {});
      if (!votes.length) return null;
      if (question.kind === 'guess') {
        const correct = votes.filter(value => normalize(value) === normalize(question.a)).length;
        totalCorrect += correct; totalResponses += votes.length;
        return { label: question.q, correct, total: votes.length, percent: votes.length ? Math.round(correct / votes.length * 100) : 0 };
      }
      const correct = votes.filter(value => Number(value) === Number(question.a)).length;
      totalCorrect += correct; totalResponses += votes.length;
      return { label: question.q, correct, total: votes.length, percent: votes.length ? Math.round(correct / votes.length * 100) : 0 };
    }).filter(Boolean);
    return { name: round, totalCorrect, totalResponses, percent: totalResponses ? Math.round(totalCorrect / totalResponses * 100) : 0, questionStats };
  });
}

function stateFor(room, voterId = '', isHost = false) {
  closeExpiredVote(room);
  const indices = currentIndices(room);
  const question = currentQuestion(room);
  if (room.started && question && !room.active && (question.kind || 'mcq') !== 'debate') {
    prepareAutomaticVote(room);
    touchRoom(room);
  }
  let stage;
  if (!room.started) stage = 'lobby';
  else if (room.quizFinished) stage = 'quiz-complete';
  else if (room.recapPending) stage = 'round-recap';
  else if (!question) stage = room.roundIndex < room.rounds.length - 1 ? 'round-complete' : 'quiz-complete';
  else if (!room.active) stage = 'waiting';
  else stage = room.active.open ? 'voting' : 'results';

  const votes = room.active?.votes || {};
  const values = Object.values(votes);
  let counts = [];
  let correctCount = null;
  let correctPercent = null;
  const kind = question?.kind || 'mcq';

  if (stage === 'results' && question) {
    if (kind === 'mcq' || kind === 'poll') {
      counts = (question.o || []).map((_, index) => values.filter(vote => Number(vote) === index).length);
    }
    if (kind === 'mcq') correctCount = values.filter(vote => Number(vote) === Number(question.a)).length;
    if (kind === 'guess') correctCount = values.filter(vote => normalize(vote) === normalize(question.a)).length;
    if (correctCount !== null) correctPercent = values.length ? Math.round((correctCount / values.length) * 100) : 0;
  }

  return {
    roomId: room.id,
    version: room.version || 1,
    serverTime: Date.now(),
    round: room.rounds[room.roundIndex] || '',
    roundIndex: room.roundIndex,
    roundsCount: room.rounds.length,
    questionNumber: question ? room.position + 1 : indices.length,
    roundCount: indices.length,
    rounds: room.rounds.map((name, index) => ({ name, index, questionCount: room.questions.filter(question => question.round === name).length, questionTitles: room.questions.filter(question => question.round === name).map(question => question.q) })),
    stage,
    question: stage === 'lobby' ? null : publicQuestion(question, stage),
    endsAt: room.active?.endsAt || null,
    durationSeconds: room.active?.durationSeconds || room.durationSeconds || 30,
    totalVotes: values.length,
    myVote: voterId ? votes[voterId] ?? null : null,
    counts,
    correctCount,
    correctPercent,
    answerIndex: stage === 'results' && question && kind === 'mcq' ? question.a : null,
    answer: stage === 'results' && question ? (typeof question.a === 'number' ? (question.o || [])[question.a] : question.a) : null,
    hostNote: isHost ? question?.hostNote || '' : '',
    recap: stage === 'round-recap' ? recapFor(room) : null,
    recapFinal: Boolean(room.recapPending && room.recapRoundIndex >= room.rounds.length - 1)
  };
}

function createRoom(body) {
  pruneRooms();
  const questions = sanitizeQuestions(body.questions);
  const rounds = [...new Set(questions.map(q => q.round))];
  const selectedRound = safeText(body.round, '', 120);
  const roundIndex = Math.max(0, rounds.indexOf(selectedRound));
  const room = {
    id: crypto.randomBytes(3).toString('hex').toUpperCase(),
    hostToken: crypto.randomBytes(18).toString('base64url'),
    questions,
    rounds,
    roundIndex,
    position: 0,
    durationSeconds: 30,
    recapPending: false,
    recapRoundIndex: null,
    quizFinished: false,
    started: false,
    active: null,
    sessions: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
    version: 1
  };
  rooms.set(room.id, room);
  persistRooms();
  return room;
}

function normalizeDuration(duration, fallback = 30) {
  return Math.min(90, Math.max(5, Number(duration) || fallback));
}

function prepareAutomaticVote(room, duration = room.durationSeconds || 30) {
  const question = currentQuestion(room);
  if (!question || (question.kind || 'mcq') === 'debate') return;
  const seconds = normalizeDuration(duration);
  room.active = {
    questionKey: questionKey(room),
    startedAt: Date.now(),
    endsAt: Date.now() + seconds * 1000,
    durationSeconds: seconds,
    open: true,
    votes: {}
  };
  rememberSession(room);
}

function startQuiz(room, duration) {
  if (room.started) return;
  room.started = true;
  prepareAutomaticVote(room, normalizeDuration(duration, 30));
  touchRoom(room);
}

function startVote(room, duration) {
  if (!room.started) throw Object.assign(new Error('Start the quiz before opening the vote.'), { status: 409 });
  const question = currentQuestion(room);
  if (!question) throw Object.assign(new Error('There is no question to vote on.'), { status: 409 });
  if ((question.kind || 'mcq') === 'debate') throw Object.assign(new Error('Discussion questions do not use timed voting.'), { status: 409 });
  prepareAutomaticVote(room, duration);
  touchRoom(room);
}

function setVoteDuration(room, duration) {
  const question = currentQuestion(room);
  if (!question || (question.kind || 'mcq') === 'debate') {
    throw Object.assign(new Error('This question does not use a timer.'), { status: 409 });
  }
  const seconds = normalizeDuration(duration);
  if (!room.active?.open) throw Object.assign(new Error('Voting is closed for this question.'), { status: 409 });
  const now = Date.now();
  room.active.startedAt = now;
  room.active.endsAt = now + seconds * 1000;
  room.active.durationSeconds = seconds;
  rememberSession(room);
  touchRoom(room);
}

function closeVote(room) {
  if (!room.active) throw Object.assign(new Error('Voting has not started for this question.'), { status: 409 });
  room.active.open = false;
  rememberSession(room);
  touchRoom(room);
}

function recordVote(room, body) {
  const voter = safeText(body.voter, '', 120);
  if (!voter) throw Object.assign(new Error('A voter id is required.'), { status: 400 });

  const state = stateFor(room, voter);
  if (state.stage !== 'voting') throw Object.assign(new Error('Voting is closed.'), { status: 409 });
  const question = currentQuestion(room);
  const kind = question.kind || 'mcq';
  if (kind === 'guess') {
    const answer = safeText(body.answer, '', 220);
    if (!answer) throw Object.assign(new Error('Enter an answer.'), { status: 400 });
    room.active.votes[voter] = answer;
  } else {
    const choice = Number(body.answer);
    if (!Number.isInteger(choice) || choice < 0 || choice >= (question.o || []).length) {
      throw Object.assign(new Error('Choose one of the listed answers.'), { status: 400 });
    }
    room.active.votes[voter] = choice;
  }

  rememberSession(room);
  touchRoom(room);
}

function skipQuestion(room) {
  const indices = currentIndices(room);
  if (room.position >= indices.length) {
    throw Object.assign(new Error('This round is already complete.'), { status: 409 });
  }
  if (room.active?.open) room.active.open = false;
  if (room.active) room.active.skipped = true;
  rememberSession(room);
  room.position += 1;
  restoreSession(room);
  if (room.position >= indices.length) markRoundRecap(room);
  if (!room.active) prepareAutomaticVote(room);
  touchRoom(room);
}

function moveNext(room) {
  const indices = currentIndices(room);
  if (room.position >= indices.length) {
    throw Object.assign(new Error('This round is already complete.'), { status: 409 });
  }
  rememberSession(room);
  room.position += 1;
  restoreSession(room);
  if (room.position >= indices.length) markRoundRecap(room);
  if (!room.active) prepareAutomaticVote(room);
  touchRoom(room);
}

function markRoundRecap(room) {
  const completed = room.roundIndex + 1;
  if (completed % 2 === 0) {
    room.recapPending = true;
    room.recapRoundIndex = room.roundIndex;
  }
}

function movePrevious(room) {
  const indices = currentIndices(room);
  if (indices.length === 0 || room.position <= 0) {
    throw Object.assign(new Error('This is the first question in the round.'), { status: 409 });
  }
  rememberSession(room);
  room.position -= 1;
  restoreSession(room);
  if (!room.active) prepareAutomaticVote(room);
  touchRoom(room);
}

function moveNextRound(room) {
  if (room.recapPending) {
    room.recapPending = false;
    if (room.roundIndex >= room.rounds.length - 1) {
      room.quizFinished = true;
      room.recapRoundIndex = null;
      touchRoom(room);
      return;
    }
    room.roundIndex += 1;
    room.position = 0;
    restoreSession(room);
    if (!room.active) prepareAutomaticVote(room);
    room.recapRoundIndex = null;
    touchRoom(room);
    return;
  }
  if (room.roundIndex >= room.rounds.length - 1) {
    throw Object.assign(new Error('This is the final round.'), { status: 409 });
  }
  rememberSession(room);
  room.roundIndex += 1;
  room.position = 0;
  restoreSession(room);
  if (!room.active) prepareAutomaticVote(room);
  touchRoom(room);
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) return 'image/jpeg';
  if (filePath.endsWith('.svg')) return 'image/svg+xml; charset=utf-8';
  return 'application/octet-stream';
}

function staticFile(req, res, url) {
  const pathname = url.pathname === '/' ? '/ai-quiz.html' : url.pathname;
  const publicFiles = new Set(['/ai-quiz.html', '/live.html']);
  if (!publicFiles.has(pathname)) {
    return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }
  const safePath = path.resolve(ROOT, `.${pathname}`);
  if (!safePath.startsWith(ROOT + path.sep) || !fs.existsSync(safePath) || !fs.statSync(safePath).isFile()) {
    return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }
  return send(res, 200, fs.readFileSync(safePath), contentType(safePath));
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/api/health') {
    pruneRooms();
    return send(res, 200, { ok: true, rooms: rooms.size, port: PORT, persistence: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/info') {
    const roomId = safeText(url.searchParams.get('room'), '', 24).toUpperCase();
    return send(res, 200, { ips: ips(), port: PORT, baseUrls: requestBaseUrls(req), joinUrls: roomId ? joinUrls(req, roomId) : [] });
  }

  if (req.method === 'POST' && url.pathname === '/api/room/create') {
    const body = await readBody(req);
    const room = createRoom(body);
    return send(res, 200, { roomId: room.id, hostToken: room.hostToken, ips: ips(), port: PORT, joinUrls: joinUrls(req, room.id) });
  }

  if (req.method === 'GET' && url.pathname === '/api/room/state') {
    const room = requireRoom(url.searchParams.get('id'));
    const voterId = safeText(url.searchParams.get('voter'), '', 120);
    const isHost = Boolean(room.hostToken && req.headers['x-quiz-host-token'] === room.hostToken);
    return send(res, 200, stateFor(room, voterId, isHost));
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/room/')) {
    const body = await readBody(req);
    const room = requireRoom(body.id);

    if (url.pathname === '/api/room/vote') {
      recordVote(room, body);
      return send(res, 200, stateFor(room, safeText(body.voter, '', 120)));
    }

    requireHost(room, body.hostToken);

    if (url.pathname === '/api/room/start') startQuiz(room, body.duration);
    else if (url.pathname === '/api/room/start-vote') startVote(room, body.duration);
    else if (url.pathname === '/api/room/set-duration') setVoteDuration(room, body.duration);
    else if (url.pathname === '/api/room/close-vote') closeVote(room);
    else if (url.pathname === '/api/room/skip') skipQuestion(room);
    else if (url.pathname === '/api/room/next') moveNext(room);
    else if (url.pathname === '/api/room/previous') movePrevious(room);
    else if (url.pathname === '/api/room/next-round') moveNextRound(room);
    else return sendError(res, 404, 'Unknown quiz action.');

    return send(res, 200, stateFor(room));
  }

  if (req.method === 'GET' || req.method === 'HEAD') return staticFile(req, res, url);
  return sendError(res, 405, 'Method not allowed.');
}

loadRooms();

http.createServer((req, res) => {
  route(req, res).catch(error => {
    if (!error.status || error.status >= 500) console.error(error);
    if (!res.headersSent) sendError(res, error.status || 500, error.status ? error.message : 'The quiz server hit an error.');
    else res.end();
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Team quiz server running on http://localhost:${PORT}/ai-quiz.html`);
  for (const ip of ips()) console.log(`Same-network participants: http://${ip}:${PORT}/live.html`);
});
