/* ============================================================
   MockPrep — AI Interview Coach
   Uses the Anthropic Claude API directly from the browser.
   ============================================================ */

const CLAUDE_API  = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-opus-4-7';

// ── App State ──────────────────────────────────────────────────────────────
const state = {
  apiKey:          '',
  jobUrl:          '',
  jobContent:      '',
  questionType:    'mix',
  numQuestions:    10,
  timePerQuestion: 2,   // minutes
  totalTime:       30,  // minutes
  feedbackTiming:  'after_each',

  questions:       [],  // [{id, type, question}]
  answers:         [],  // [{questionId, answer, timeTaken, skipped}]
  feedbacks:       [],  // [{questionId, score, well, missed, improve}]

  currentIndex:    0,
  questionStarted: null,  // timestamp
  interviewStarted: null, // timestamp

  questionTimerId: null,
  totalTimerId:    null,
  questionSecsLeft: 0,
  totalSecsLeft:    0,
};

// ── Helpers ────────────────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const fmtTime = secs => {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
};

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
  window.scrollTo(0, 0);
}

async function callClaude(apiKey, messages, systemPrompt) {
  const res = await fetch(CLAUDE_API, {
    method: 'POST',
    headers: {
      'content-type':                            'application/json',
      'x-api-key':                               apiKey,
      'anthropic-version':                       '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `API error ${res.status}`);
  }

  const data = await res.json();
  return data.content[0].text;
}

function parseJSON(text) {
  // Strip markdown fences if present
  const clean = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  return JSON.parse(clean);
}

// ── Setup Screen Logic ─────────────────────────────────────────────────────
function initSetup() {
  // Toggle groups
  document.querySelectorAll('[data-value]').forEach(btn => {
    if (!btn.classList.contains('btn-option')) return;
    btn.addEventListener('click', () => {
      const group = btn.closest('.button-group');
      group.querySelectorAll('.btn-option').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Radio cards
  document.querySelectorAll('.radio-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.radio-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
    });
  });

  // Toggle API key visibility
  $('toggle-key').addEventListener('click', () => {
    const input = $('api-key');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  // Start button
  $('start-btn').addEventListener('click', handleStart);
}

function getSetupValues() {
  const apiKey = $('api-key').value.trim();
  const jobUrl = $('job-url').value.trim();

  const questionType = document.querySelector('#question-type-group .btn-option.active')?.dataset.value || 'mix';
  const numQuestions = parseInt(document.querySelector('#num-questions-group .btn-option.active')?.dataset.value || 10);
  const timePerQuestion = parseInt(document.querySelector('#time-per-question-group .btn-option.active')?.dataset.value || 2);
  const totalTime = parseInt(document.querySelector('#total-time-group .btn-option.active')?.dataset.value || 30);
  const feedbackTiming = document.querySelector('.radio-card.active')?.dataset.value || 'after_each';

  return { apiKey, jobUrl, questionType, numQuestions, timePerQuestion, totalTime, feedbackTiming };
}

function showSetupError(msg) {
  const el = $('setup-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

async function handleStart() {
  $('setup-error').classList.add('hidden');
  const vals = getSetupValues();

  if (!vals.apiKey.startsWith('sk-')) {
    return showSetupError('Please enter a valid Anthropic API key (starts with sk-ant- or sk-).');
  }
  if (!vals.jobUrl) {
    return showSetupError('Please enter the job description URL.');
  }

  // Copy into state
  Object.assign(state, vals);
  state.questions = [];
  state.answers   = [];
  state.feedbacks = [];
  state.currentIndex = 0;

  showScreen('loading-screen');

  try {
    // Step 1: fetch job description
    setLoadingStep('step-fetch', 'active');
    state.jobContent = await fetchJobDescription(vals.jobUrl);
    setLoadingStep('step-fetch', 'done');

    // Step 2: generate questions
    setLoadingStep('step-generate', 'active');
    state.questions = await generateQuestions();
    setLoadingStep('step-generate', 'done');

    // Step 3: finalize
    setLoadingStep('step-ready', 'active');
    await new Promise(r => setTimeout(r, 600));
    setLoadingStep('step-ready', 'done');

    startInterview();
  } catch (err) {
    showScreen('setup-screen');
    showSetupError(`Error: ${err.message}`);
  }
}

function setLoadingStep(id, status) {
  const el = $(id);
  el.classList.remove('active', 'done');
  if (status) el.classList.add(status);
}

async function fetchJobDescription(url) {
  // Try CORS proxy to get actual page content
  try {
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      // Strip HTML tags, collapse whitespace
      const text = (data.contents || '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 6000);
      if (text.length > 200) return text;
    }
  } catch (_) { /* fall through */ }

  // Fallback: use URL itself as context
  return `Job posting URL: ${url}\n(Full content unavailable — generate relevant questions based on the URL and role inferred from it.)`;
}

async function generateQuestions() {
  const typeMap = {
    behavioral: 'behavioral (STAR-format) questions only',
    technical:  'technical/role-specific questions only',
    mix:        'a mix of behavioral (STAR-format) and technical/role-specific questions',
  };
  const typeInstruction = typeMap[state.questionType];

  const systemPrompt = `You are an expert technical recruiter and interview coach.
Your task is to generate realistic interview questions tailored to a specific job description.
Always respond with valid JSON only — no markdown, no extra text.`;

  const userMessage = `
Generate exactly ${state.numQuestions} interview questions based on this job description.
Question type: ${typeInstruction}

Job Description:
${state.jobContent}

Return a JSON object in this exact format:
{
  "questions": [
    {
      "id": 1,
      "type": "behavioral",
      "question": "Tell me about a time when..."
    }
  ]
}

Rules:
- "type" must be either "behavioral" or "technical"
- Questions should be realistic and directly relevant to the role
- Behavioral questions should invite STAR-method answers
- Technical questions should test relevant skills from the job description
- Vary difficulty and topics across the ${state.numQuestions} questions
- No duplicate questions
`;

  const raw = await callClaude(state.apiKey, [{ role: 'user', content: userMessage }], systemPrompt);
  const parsed = parseJSON(raw);

  if (!parsed.questions || !Array.isArray(parsed.questions)) {
    throw new Error('Could not parse questions from AI response.');
  }

  return parsed.questions.slice(0, state.numQuestions);
}

// ── Interview Screen Logic ─────────────────────────────────────────────────
function startInterview() {
  state.currentIndex   = 0;
  state.interviewStarted = Date.now();
  state.totalSecsLeft   = state.totalTime * 60;

  buildProgressDots();
  showScreen('interview-screen');
  displayQuestion(0);
  startTotalTimer();
}

function buildProgressDots() {
  const container = $('progress-dots');
  container.innerHTML = '';
  state.questions.forEach((_, i) => {
    const dot = document.createElement('div');
    dot.className = 'progress-dot';
    dot.id = `dot-${i}`;
    container.appendChild(dot);
  });
}

function updateProgressDots() {
  state.questions.forEach((_, i) => {
    const dot = $(`dot-${i}`);
    if (!dot) return;
    dot.classList.remove('current', 'answered', 'skipped');
    if (i < state.currentIndex) {
      const ans = state.answers.find(a => a.questionId === state.questions[i].id);
      dot.classList.add(ans?.skipped ? 'skipped' : 'answered');
    } else if (i === state.currentIndex) {
      dot.classList.add('current');
    }
  });
}

function displayQuestion(index) {
  const q = state.questions[index];
  $('interview-progress').textContent = `Question ${index + 1} of ${state.numQuestions}`;
  $('question-number-label').textContent = `Question ${index + 1}`;
  $('question-text').textContent = q.question;
  $('answer-input').value = '';
  $('word-count').textContent = '0 words';

  const badge = $('question-type-badge');
  badge.textContent = q.type === 'technical' ? 'Technical' : 'Behavioral';
  badge.className = `badge ${q.type}`;

  updateProgressDots();
  startQuestionTimer();
  state.questionStarted = Date.now();
}

function startQuestionTimer() {
  clearInterval(state.questionTimerId);
  const totalSecs = state.timePerQuestion * 60;
  state.questionSecsLeft = totalSecs;

  updateQuestionTimerUI(totalSecs, totalSecs);

  state.questionTimerId = setInterval(() => {
    state.questionSecsLeft--;
    updateQuestionTimerUI(state.questionSecsLeft, totalSecs);

    if (state.questionSecsLeft <= 0) {
      clearInterval(state.questionTimerId);
      autoSkipQuestion();
    }
  }, 1000);
}

function updateQuestionTimerUI(secs, totalSecs) {
  const pct = (secs / totalSecs) * 100;
  const bar  = $('question-timer-bar');
  const text = $('question-timer-text');

  bar.style.width = `${pct}%`;

  bar.classList.remove('warning', 'critical');
  text.classList.remove('warning', 'critical');

  if (secs <= 10) {
    bar.classList.add('critical');
    text.classList.add('critical');
  } else if (secs <= 30) {
    bar.classList.add('warning');
    text.classList.add('warning');
  }

  text.textContent = fmtTime(secs);
}

function startTotalTimer() {
  clearInterval(state.totalTimerId);

  state.totalTimerId = setInterval(() => {
    state.totalSecsLeft--;
    updateTotalTimerUI(state.totalSecsLeft);

    if (state.totalSecsLeft <= 0) {
      clearInterval(state.totalTimerId);
      endInterview(true);
    }
  }, 1000);
}

function updateTotalTimerUI(secs) {
  const text = $('total-timer-text');
  const wrap = $('total-timer-display');

  text.textContent = fmtTime(secs);

  wrap.classList.remove('warning', 'critical');
  if (secs <= 60)         wrap.classList.add('critical');
  else if (secs <= 300)   wrap.classList.add('warning');

  // Mirror to feedback screen timer
  $('feedback-timer-text').textContent = fmtTime(secs);
}

function autoSkipQuestion() {
  const q = state.questions[state.currentIndex];
  state.answers.push({
    questionId: q.id,
    answer: $('answer-input').value.trim() || '(Time expired — no answer submitted)',
    timeTaken: state.timePerQuestion * 60,
    skipped: !$('answer-input').value.trim(),
  });

  advanceToNextQuestion();
}

async function handleSubmitAnswer() {
  clearInterval(state.questionTimerId);

  const q      = state.questions[state.currentIndex];
  const answer = $('answer-input').value.trim();
  const elapsed = Math.round((Date.now() - state.questionStarted) / 1000);

  state.answers.push({
    questionId: q.id,
    answer: answer || '(No answer provided)',
    timeTaken: elapsed,
    skipped: !answer,
  });

  if (state.feedbackTiming === 'after_each') {
    $('submit-answer-btn').disabled = true;
    $('submit-answer-btn').textContent = 'Getting feedback…';

    try {
      const fb = await getFeedbackForAnswer(q, answer);
      state.feedbacks.push(fb);
      showPerQuestionFeedback(fb, q, answer);
    } catch (err) {
      // If feedback fails, just move on
      state.feedbacks.push({ questionId: q.id, score: 0, well: 'N/A', missed: 'N/A', improve: 'N/A', error: true });
      advanceToNextQuestion();
    }

    $('submit-answer-btn').disabled = false;
    $('submit-answer-btn').innerHTML = `Submit Answer <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
  } else {
    advanceToNextQuestion();
  }
}

async function getFeedbackForAnswer(question, answer) {
  const systemPrompt = `You are an expert interview coach providing detailed, constructive feedback.
Always respond with valid JSON only — no markdown, no extra text.`;

  const userMessage = `
Evaluate this interview answer:

Question: ${question.question}
Question Type: ${question.type}
Candidate's Answer: ${answer || '(No answer provided)'}

Job Context:
${state.jobContent.slice(0, 2000)}

Provide feedback as JSON in this exact format:
{
  "questionId": ${question.id},
  "score": <integer 1-10>,
  "what_went_well": "<2-3 sentences about strengths>",
  "what_was_missed": "<2-3 sentences about gaps or missing elements>",
  "how_to_improve": "<2-3 actionable improvement tips>"
}

Scoring guide: 1-3 poor, 4-6 average, 7-8 good, 9-10 excellent.
If no answer was provided, score it 1 and note that in the feedback.
`;

  const raw = await callClaude(state.apiKey, [{ role: 'user', content: userMessage }], systemPrompt);
  return parseJSON(raw);
}

function showPerQuestionFeedback(fb, question, answer) {
  const score = fb.score || 0;
  const scoreEl = $('feedback-score-circle');

  $('feedback-score-num').textContent = score;
  scoreEl.removeAttribute('data-score');
  if (score >= 8)      scoreEl.setAttribute('data-score', 'good');
  else if (score >= 5) scoreEl.setAttribute('data-score', 'average');
  else                 scoreEl.setAttribute('data-score', 'poor');

  $('feedback-progress-label').textContent =
    `Feedback — Question ${state.currentIndex + 1} of ${state.numQuestions}`;
  $('feedback-question-recap').textContent = question.question;
  $('feedback-answer-recap').textContent = answer || '(No answer provided)';

  $('feedback-well').textContent    = fb.what_went_well || '';
  $('feedback-missed').textContent  = fb.what_was_missed || '';
  $('feedback-improve').textContent = fb.how_to_improve || '';

  const isLast = state.currentIndex >= state.numQuestions - 1;
  $('next-btn-label').textContent = isLast ? 'View Results' : 'Next Question';

  showScreen('feedback-screen');
}

function advanceToNextQuestion() {
  if (state.currentIndex >= state.numQuestions - 1) {
    endInterview(false);
  } else {
    state.currentIndex++;
    showScreen('interview-screen');
    displayQuestion(state.currentIndex);
  }
}

function endInterview(timeUp) {
  clearInterval(state.questionTimerId);
  clearInterval(state.totalTimerId);

  const totalSecsUsed = (state.totalTime * 60) - state.totalSecsLeft;
  state.timeUsed = totalSecsUsed;

  buildResults();
}

// ── Results Screen Logic ───────────────────────────────────────────────────
async function buildResults() {
  showScreen('results-screen');

  const answered = state.answers.filter(a => !a.skipped).length;
  $('stat-questions-answered').textContent = `${answered}/${state.numQuestions}`;
  $('stat-time-used').textContent = fmtTime(state.timeUsed || 0);

  if (state.feedbackTiming === 'after_each') {
    // Feedback already collected, just compute score
    renderResults();
  } else {
    // Generate all feedback now
    $('results-loading').classList.remove('hidden');
    $('results-questions-list').innerHTML = '';
    $('results-summary-text').textContent = 'Generating feedback…';

    try {
      await generateAllFeedback();
    } catch (err) {
      $('results-loading').innerHTML = `<p style="color:var(--red)">Could not generate feedback: ${err.message}</p>`;
    }

    $('results-loading').classList.add('hidden');
    renderResults();
  }
}

async function generateAllFeedback() {
  // Build a single prompt with all Q&A pairs for efficiency
  const qaPairs = state.questions.map((q, i) => {
    const ans = state.answers.find(a => a.questionId === q.id);
    return `Question ${i + 1} (${q.type}): ${q.question}\nAnswer: ${ans?.answer || '(No answer)'}`;
  }).join('\n\n---\n\n');

  const systemPrompt = `You are an expert interview coach.
Always respond with valid JSON only — no markdown, no extra text.`;

  const userMessage = `
Evaluate all ${state.numQuestions} interview answers below.

Job Context:
${state.jobContent.slice(0, 2000)}

Q&A Pairs:
${qaPairs}

Return a JSON object in this exact format:
{
  "overall_summary": "<3-4 sentences summarizing overall performance>",
  "feedbacks": [
    {
      "questionId": <id>,
      "score": <1-10>,
      "what_went_well": "<2-3 sentences>",
      "what_was_missed": "<2-3 sentences>",
      "how_to_improve": "<2-3 actionable tips>"
    }
  ]
}

Include one feedback object per question, in order.
Scoring: 1-3 poor, 4-6 average, 7-8 good, 9-10 excellent.
`;

  const raw = await callClaude(state.apiKey, [{ role: 'user', content: userMessage }], systemPrompt);
  const parsed = parseJSON(raw);

  if (parsed.feedbacks) {
    state.feedbacks = parsed.feedbacks;
  }
  if (parsed.overall_summary) {
    state.overallSummary = parsed.overall_summary;
  }
}

async function generateOverallSummary() {
  if (state.overallSummary) return state.overallSummary;

  const avgScore = computeAverageScore();
  const systemPrompt = `You are an expert interview coach. Be concise and specific.`;

  const summary = await callClaude(state.apiKey, [{
    role: 'user',
    content: `Based on an interview with ${state.numQuestions} questions where the candidate scored ${avgScore.toFixed(1)}/10 on average, write a 3-4 sentence performance summary. Mention strengths and key areas to improve. Job context: ${state.jobContent.slice(0, 500)}`,
  }], systemPrompt);

  return summary.trim();
}

function computeAverageScore() {
  if (!state.feedbacks.length) return 0;
  const sum = state.feedbacks.reduce((acc, fb) => acc + (fb.score || 0), 0);
  return sum / state.feedbacks.length;
}

function scoreGradeClass(pct) {
  if (pct >= 80) return 'excellent';
  if (pct >= 60) return 'good';
  if (pct >= 40) return 'average';
  return 'poor';
}

function scoreGradeLabel(pct) {
  if (pct >= 90) return 'Outstanding Performance!';
  if (pct >= 80) return 'Excellent Job!';
  if (pct >= 70) return 'Great Performance!';
  if (pct >= 60) return 'Good Effort!';
  if (pct >= 50) return 'Solid Attempt!';
  if (pct >= 40) return 'Room to Improve';
  return 'Keep Practicing!';
}

async function renderResults() {
  const avg = computeAverageScore();
  const pct = Math.round((avg / 10) * 100);
  const gradeClass = scoreGradeClass(pct);

  // Score ring
  $('results-score-pct').textContent = `${pct}%`;
  $('results-grade-label').textContent = scoreGradeLabel(pct);
  $('stat-avg-score').textContent = avg.toFixed(1);

  const ring = $('score-ring-fill');
  ring.className = `score-ring-fill grade-${gradeClass}`;
  const circumference = 314;
  const offset = circumference - (pct / 100) * circumference;
  setTimeout(() => { ring.style.strokeDashoffset = offset; }, 100);

  // Summary
  if (!state.overallSummary) {
    try {
      state.overallSummary = await generateOverallSummary();
    } catch (_) {
      state.overallSummary = `You completed ${state.answers.filter(a=>!a.skipped).length} out of ${state.numQuestions} questions with an average score of ${avg.toFixed(1)}/10.`;
    }
  }
  $('results-summary-text').textContent = state.overallSummary;

  // Question breakdown
  const list = $('results-questions-list');
  list.innerHTML = '';

  state.questions.forEach((q, i) => {
    const ans = state.answers.find(a => a.questionId === q.id);
    const fb  = state.feedbacks.find(f => f.questionId === q.id);
    const score = fb?.score ?? null;
    const pctQ  = score !== null ? (score / 10) * 100 : null;
    const badgeClass = pctQ !== null ? scoreGradeClass(pctQ) : 'average';

    const card = document.createElement('div');
    card.className = 'result-question-card';
    card.innerHTML = `
      <div class="rq-header" data-index="${i}">
        <div class="rq-header-left">
          <span class="rq-num">${i + 1}</span>
          <span class="rq-question-preview">${escHtml(q.question)}</span>
        </div>
        ${score !== null ? `<span class="rq-score-badge ${badgeClass}">${score}/10</span>` : ''}
        <svg class="rq-chevron" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </div>
      <div class="rq-body" id="rq-body-${i}">
        <div class="rq-section">
          <div class="rq-section-label">Your Answer</div>
          <div class="rq-section-content">${escHtml(ans?.answer || '(No answer provided)')}</div>
        </div>
        ${fb ? `
        <div class="rq-feedback-grid">
          <div class="rq-fb-item well">
            <div class="rq-fb-label">✅ What Went Well</div>
            <p>${escHtml(fb.what_went_well || '')}</p>
          </div>
          <div class="rq-fb-item missed">
            <div class="rq-fb-label">⚠️ What Was Missed</div>
            <p>${escHtml(fb.what_was_missed || '')}</p>
          </div>
          <div class="rq-fb-item improve">
            <div class="rq-fb-label">🚀 How to Improve</div>
            <p>${escHtml(fb.how_to_improve || '')}</p>
          </div>
        </div>` : '<p style="color:var(--text-muted);font-size:.85rem;margin-top:12px;">Feedback unavailable for this question.</p>'}
      </div>
    `;

    list.appendChild(card);

    // Toggle expand/collapse
    card.querySelector('.rq-header').addEventListener('click', () => {
      const body = $(`rq-body-${i}`);
      const hdr  = card.querySelector('.rq-header');
      const isOpen = body.classList.contains('visible');
      body.classList.toggle('visible', !isOpen);
      hdr.classList.toggle('expanded', !isOpen);
    });
  });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Event Listeners ────────────────────────────────────────────────────────
function initEventListeners() {
  // Submit answer
  $('submit-answer-btn').addEventListener('click', handleSubmitAnswer);

  // Word count
  $('answer-input').addEventListener('input', () => {
    const words = $('answer-input').value.trim().split(/\s+/).filter(Boolean).length;
    $('word-count').textContent = `${words} word${words !== 1 ? 's' : ''}`;
  });

  // Next question (from per-question feedback)
  $('next-question-btn').addEventListener('click', advanceToNextQuestion);

  // End interview early
  $('end-interview-btn').addEventListener('click', () => {
    if (confirm('Are you sure you want to end the interview now?')) {
      endInterview(false);
    }
  });

  // New interview
  $('new-interview-btn').addEventListener('click', () => {
    clearInterval(state.questionTimerId);
    clearInterval(state.totalTimerId);
    showScreen('setup-screen');
  });
}

// ── Boot ───────────────────────────────────────────────────────────────────
function init() {
  initSetup();
  initEventListeners();
}

document.addEventListener('DOMContentLoaded', init);
