// State management
let state = {
  token: localStorage.getItem('token') || null,
  user: JSON.parse(localStorage.getItem('user')) || null,
  courses: [],
  activeCourse: null,
  activeLesson: null,
  sessionId: null,
  heartbeatInterval: null,
  lastActivityTime: Date.now(),
  userActive: true,
  hashChain: [],
  isDeleting: false,
};

const API_BASE = '/api';

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  initApp();
});

function initApp() {
  lucide.createIcons();
  
  if (state.token && state.user) {
    showMainInterface();
  } else {
    showScreen('login-screen');
    loadQuickSelectUsers();
  }
}

async function loadQuickSelectUsers() {
  const quickSelect = document.getElementById('login-quick-select');
  if (!quickSelect) return;

  try {
    const response = await fetch(`${API_BASE}/auth/users`);
    if (!response.ok) throw new Error('Failed to fetch users');
    const usersList = await response.json();

    quickSelect.innerHTML = '<option value="">-- Benutzer auswählen (Auto-Login) --</option>';
    
    // Add default mock admin if not in DB list
    const hasDefaultAdmin = usersList.some(u => u.email === 'student@tenant-alpha.com');
    if (!hasDefaultAdmin) {
      usersList.push({
        email: 'student@tenant-alpha.com',
        role: 'admin',
        tenantId: '11111111-1111-1111-1111-111111111111'
      });
    }

    usersList.forEach(u => {
      const opt = document.createElement('option');
      opt.value = JSON.stringify(u);
      opt.textContent = `${u.email} (${u.role === 'admin' ? 'Admin' : 'Schüler'} - Mandant: ${u.tenantId.slice(0, 8)}...)`;
      quickSelect.appendChild(opt);
    });

    // Handle change event to auto-fill and login
    quickSelect.addEventListener('change', (e) => {
      const val = e.target.value;
      if (!val) return;
      
      const userData = JSON.parse(val);
      document.getElementById('login-email').value = userData.email;
      document.getElementById('login-tenant').value = userData.tenantId;
      document.getElementById('login-role').value = userData.role;
      
      // Auto-submit the login form
      const loginForm = document.getElementById('login-form');
      if (loginForm) {
        // Trigger submit handler programmatically with a safe mock event
        handleLogin({ preventDefault: () => {} });
      }
    });
  } catch (err) {
    console.error('Error loading quick select users:', err);
    quickSelect.innerHTML = '<option value="">Fehler beim Laden der Benutzer</option>';
  }
}

// UI Screen management
function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => {
    s.classList.remove('active');
    s.style.display = 'none';
  });
  const activeScreen = document.getElementById(screenId);
  activeScreen.style.display = screenId === 'login-screen' ? 'flex' : 'block';
  setTimeout(() => activeScreen.classList.add('active'), 50);
}

function showMainInterface() {
  showScreen('main-interface');
  document.getElementById('user-display').textContent = state.user.email;
  
  const roleBadge = document.getElementById('role-badge');
  roleBadge.textContent = state.user.role;
  roleBadge.className = 'badge ' + (state.user.role === 'admin' ? 'admin' : 'student');

  if (state.user.role === 'admin') {
    document.getElementById('student-dashboard').classList.add('hidden');
    document.getElementById('admin-dashboard').classList.remove('hidden');
    loadAdminDashboard();
    loadUsageStats();
    // Start polling for course generation status
    startAdminPolling();
  } else {
    document.getElementById('admin-dashboard').classList.add('hidden');
    document.getElementById('student-dashboard').classList.remove('hidden');
    document.getElementById('classroom-view').classList.add('hidden');
    document.getElementById('student-courses-grid').classList.remove('hidden');
    loadStudentDashboard();
  }
  lucide.createIcons();
}

// Event Listeners setup
function setupEventListeners() {
  // Login form
  document.getElementById('login-form').addEventListener('submit', handleLogin);
  
  // Logout button
  document.getElementById('logout-btn').addEventListener('click', handleLogout);

  // Admin: Course Generator form
  document.getElementById('course-generator-form').addEventListener('submit', handleGenerateCourse);

  // Admin: Config form
  document.getElementById('admin-config-form').addEventListener('submit', handleSaveConfig);

  // Admin: Test OpenRouter Key button
  document.getElementById('btn-test-openrouter').addEventListener('click', handleTestOpenRouter);

  // Admin: Test ElevenLabs Key button
  document.getElementById('btn-test-elevenlabs').addEventListener('click', handleTestElevenLabs);

  // Admin: Toggle Config Header
  document.getElementById('admin-config-header').addEventListener('click', toggleConfigPanel);

  // Admin: Verify Chain button
  document.getElementById('verify-chain-btn').addEventListener('click', handleVerifyChain);

  // Student: Back to courses
  document.getElementById('back-to-courses').addEventListener('click', () => {
    stopHeartbeats();
    document.getElementById('classroom-view').classList.add('hidden');
    document.getElementById('student-courses-grid').classList.remove('hidden');
    loadStudentDashboard();
  });

  // Classroom Tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      
      e.target.classList.add('active');
      document.getElementById(e.target.dataset.tab).classList.add('active');
    });
  });

  // RAG Chat form
  document.getElementById('tutor-chat-form').addEventListener('submit', handleTutorQuery);

  // Student activity monitors
  const recordActivity = () => {
    state.lastActivityTime = Date.now();
    state.userActive = true;
  };
  window.addEventListener('mousemove', recordActivity);
  window.addEventListener('keydown', recordActivity);
  window.addEventListener('scroll', recordActivity);
}

// Authentication
async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const tenantId = document.getElementById('login-tenant').value;
  const role = document.getElementById('login-role').value;

  try {
    const response = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, tenantId, role }),
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const data = await response.json();
    state.token = data.token;
    state.user = data.user;
    
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
    
    showMainInterface();
  } catch (err) {
    alert('Login fehlgeschlagen: ' + err.message);
  }
}

function handleLogout() {
  stopHeartbeats();
  stopAdminPolling();
  state.token = null;
  state.user = null;
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  showScreen('login-screen');
}

// API Fetch helper
async function apiCall(endpoint, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(state.token ? { 'Authorization': `Bearer ${state.token}` } : {}),
    ...options.headers,
  };

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  });

  if (response.status === 401 || response.status === 403) {
    handleLogout();
    throw new Error('Sitzung abgelaufen. Bitte erneut einloggen.');
  }

  if (!response.ok) {
    const errorText = await response.text();
    let message = errorText || response.statusText;
    try {
      const parsed = JSON.parse(errorText);
      message = parsed.error || parsed.detail || message;
    } catch (_) { /* keep raw text */ }
    throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
  }

  return await response.json();
}

// ==================== STUDENT LOGIC ====================

async function loadStudentDashboard() {
  try {
    const grid = document.getElementById('student-courses-grid');
    grid.innerHTML = '<p>Lade Kurse...</p>';
    
    const courses = await apiCall('/courses');
    state.courses = courses;

    if (courses.length === 0) {
      grid.innerHTML = '<p class="subtitle">Bisher wurden keine Kurse generiert. Bitte wenden Sie sich an den Admin.</p>';
      return;
    }

    grid.innerHTML = '';
    courses.forEach(course => {
      const card = document.createElement('div');
      card.className = 'glass-card course-card';
      card.onclick = () => selectCourse(course.id);
      
      let statusText = '';
      if (course.status === 'generating') {
        const prog = course.progress || { percent: 0, step: 'Gestartet' };
        statusText = `Wird generiert (${prog.percent}% - ${prog.step})`;
      } else {
        statusText = {
          pending_approval: 'Wartet auf Freigabe...',
          active: 'Aktiv / Bereit',
          failed: 'Fehlgeschlagen',
        }[course.status];
      }

      card.innerHTML = `
        <div>
          <h4>${course.topic}</h4>
          <p class="subtitle">Erstellt: ${new Date(course.createdAt).toLocaleDateString()}</p>
        </div>
        <div class="course-status-wrapper" style="display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 8px;">
          <span class="status-dot ${course.status}"></span>
          <span style="font-size: 0.85rem;">${statusText}</span>
          ${course.status === 'generating' ? `
            <div style="width: 100%; height: 3px; background: rgba(255,255,255,0.05); border-radius: 1.5px; margin-top: 4px; overflow: hidden; grid-column: span 2;">
              <div style="width: ${(course.progress || {percent: 0}).percent}%; height: 100%; background: linear-gradient(90deg, var(--accent-primary), var(--accent-secondary)); transition: width 0.4s ease;"></div>
            </div>
          ` : ''}
        </div>
      `;
      grid.appendChild(card);
    });
    lucide.createIcons();
  } catch (err) {
    console.error('Failed to load student courses:', err.message);
  }
}

async function selectCourse(courseId) {
  try {
    const courseDetails = await apiCall(`/courses/${courseId}`);
    state.activeCourse = courseDetails.course;

    if (state.activeCourse.status === 'generating') {
      alert('Dieser Kurs wird gerade generiert. Bitte gedulden Sie sich.');
      return;
    }
    if (state.activeCourse.status === 'pending_approval') {
      alert('Dieser Kurs wartet auf die Freigabe durch den Administrator.');
      return;
    }
    if (state.activeCourse.status === 'failed') {
      alert('Die Generierung dieses Kurses ist fehlgeschlagen.');
      return;
    }

    // Enter classroom
    document.getElementById('student-courses-grid').classList.add('hidden');
    document.getElementById('classroom-view').classList.remove('hidden');
    
    document.getElementById('classroom-course-title').textContent = state.activeCourse.topic;
    
    // Injected accordion
    const modulesList = document.getElementById('classroom-modules-list');
    modulesList.innerHTML = '';

    courseDetails.modules.forEach(mod => {
      const modGroup = document.createElement('div');
      modGroup.className = 'module-group';
      modGroup.innerHTML = `<h5>${mod.title}</h5>`;
      
      const lessonsList = document.createElement('ul');
      lessonsList.className = 'lessons-list';

      const modLessons = courseDetails.lessons.filter(l => l.moduleId === mod.id);
      modLessons.forEach(les => {
        const item = document.createElement('li');
        item.className = 'lesson-item';
        item.dataset.id = les.id;
        item.onclick = () => selectLesson(les, courseDetails.lessons);
        item.innerHTML = `
          <i data-lucide="play-circle"></i>
          <span>${les.title}</span>
        `;
        lessonsList.appendChild(item);
      });
      modGroup.appendChild(lessonsList);
      modulesList.appendChild(modGroup);
    });

    lucide.createIcons();

    // Select first lesson by default
    if (courseDetails.lessons.length > 0) {
      selectLesson(courseDetails.lessons[0], courseDetails.lessons);
    }
  } catch (err) {
    alert('Fehler beim Laden des Kurses: ' + err.message);
  }
}

function selectLesson(lesson, allLessons) {
  state.activeLesson = lesson;
  
  // Highlight active
  document.querySelectorAll('.lesson-item').forEach(item => {
    item.classList.toggle('active', item.dataset.id === lesson.id);
  });

  document.getElementById('lesson-title').textContent = lesson.title;
  
  // Set theory text (Markdown structure)
  const payload = lesson.contentPayload || {};
  
  // Load slides
  if (typeof classroomSlideState !== 'undefined') {
    classroomSlideState.slides = payload.slides || [];
    classroomSlideState.currentIndex = 0;
    if (typeof renderActiveSlide === 'function') {
      renderActiveSlide();
    }
  }

  document.getElementById('lesson-text').innerHTML = formatMarkdown(payload.text_content || '# Keine Theorie vorhanden');

  // Media player: unique per-lesson audio/video + slide stage for audio-only
  setupLessonMediaPlayer(lesson);

  // Load Quiz
  const quizContainer = document.getElementById('lesson-quiz');
  quizContainer.innerHTML = '';

  if (payload.quiz && payload.quiz.length > 0) {
    payload.quiz.forEach((q, qIndex) => {
      const qBlock = document.createElement('div');
      qBlock.className = 'quiz-question-block';
      qBlock.innerHTML = `<h5>Frage ${qIndex + 1}: ${q.question}</h5>`;
      
      const optionsDiv = document.createElement('div');
      optionsDiv.className = 'quiz-options';
      
      q.options.forEach((opt, oIndex) => {
        const optBtn = document.createElement('div');
        optBtn.className = 'quiz-option';
        optBtn.textContent = opt;
        optBtn.onclick = () => submitQuizAnswer(optBtn, q, oIndex, q.correct_option_index, q.explanation);
        optionsDiv.appendChild(optBtn);
      });

      qBlock.appendChild(optionsDiv);
      quizContainer.appendChild(qBlock);
    });
  } else {
    quizContainer.innerHTML = '<p class="subtitle">Kein Wissenstest für diese Lektion verfügbar.</p>';
  }

  // Start tamper-proof time-tracking for this lesson
  startHeartbeats();
}

// Tamper-proof Heartbeat loop
function startHeartbeats() {
  stopHeartbeats();
  
  state.sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  state.hashChain = [];
  document.getElementById('active-session-id').textContent = state.sessionId;
  document.getElementById('session-hash-chain').innerHTML = '';

  // In development, send heartbeats every 10 seconds to make it immediately visible.
  // In production, this would be 3 minutes (180s)
  const intervalTime = 10000; 

  console.log(`Starting heartbeat chain for session: ${state.sessionId}`);
  
  state.heartbeatInterval = setInterval(async () => {
    // Check if user is active (DOM events detected in last 20 seconds)
    const inactiveDuration = Date.now() - state.lastActivityTime;
    if (inactiveDuration > 20000) {
      state.userActive = false;
      document.querySelector('.status-indicator').style.backgroundColor = 'var(--accent-error)';
      console.log('Heartbeat suspended due to user inactivity (AFK).');
      return;
    }

    state.userActive = true;
    document.querySelector('.status-indicator').style.backgroundColor = 'var(--accent-success)';

    try {
      const res = await apiCall('/time-tracking/heartbeat', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: state.sessionId,
          durationSec: Math.floor(intervalTime / 1000),
        }),
      });

      state.hashChain.push(res);
      renderHashChain();
    } catch (err) {
      console.error('Failed to send heartbeat:', err.message);
    }
  }, intervalTime);
}

function stopHeartbeats() {
  if (state.heartbeatInterval) {
    clearInterval(state.heartbeatInterval);
    state.heartbeatInterval = null;
  }
}

function renderHashChain() {
  const container = document.getElementById('session-hash-chain');
  container.innerHTML = '';
  
  // Render reverse order (newest block on top)
  [...state.hashChain].reverse().forEach((block, idx) => {
    const blockIndex = state.hashChain.length - 1 - idx;
    const isGenesis = block.previousHash.startsWith('00000000');
    
    const div = document.createElement('div');
    div.className = 'chain-block';
    div.innerHTML = `
      <div><strong>Block #${blockIndex}</strong> (${new Date(block.timestamp).toLocaleTimeString()})</div>
      <div>Dauer: ${block.durationSec}s</div>
      <div>Prev: <span class="hash">${isGenesis ? 'GENESIS BLOCK' : block.previousHash.slice(0, 16) + '...'}</span></div>
      <div>Hash: <span class="hash">${block.cryptoHash.slice(0, 32)}...</span></div>
    `;
    container.appendChild(div);
  });
}

function submitQuizAnswer(element, question, selectedIdx, correctIdx, explanation) {
  // Disable option changes
  const parent = element.parentElement;
  if (parent.querySelector('.correct') || parent.querySelector('.incorrect')) return;

  element.classList.add('selected');
  
  setTimeout(() => {
    parent.querySelectorAll('.quiz-option').forEach((opt, idx) => {
      if (idx === correctIdx) {
        opt.classList.add('correct');
      } else if (idx === selectedIdx) {
        opt.classList.add('incorrect');
      }
    });

    // Add explanation
    const expDiv = document.createElement('div');
    expDiv.className = 'quiz-explanation';
    expDiv.textContent = `Erklärung: ${explanation}`;
    parent.parentElement.appendChild(expDiv);
  }, 400);
}

// RAG Chatbot
async function handleTutorQuery(e) {
  e.preventDefault();
  const queryInput = document.getElementById('tutor-query');
  const query = queryInput.value.trim();
  if (!query) return;

  queryInput.value = '';

  // Append user message
  const chatMessages = document.getElementById('tutor-chat-messages');
  const userMsg = document.createElement('div');
  userMsg.className = 'message user';
  userMsg.textContent = query;
  chatMessages.appendChild(userMsg);
  
  // Scroll to bottom
  chatMessages.scrollTop = chatMessages.scrollHeight;

  // Add thinking indicator
  const thinkingMsg = document.createElement('div');
  thinkingMsg.className = 'message tutor thinking';
  thinkingMsg.textContent = 'KI Tutor überlegt...';
  chatMessages.appendChild(thinkingMsg);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  try {
    const response = await apiCall('/tutor/query', {
      method: 'POST',
      body: JSON.stringify({
        courseId: state.activeCourse.id,
        query,
      }),
    });

    chatMessages.removeChild(thinkingMsg);

    const tutorMsg = document.createElement('div');
    tutorMsg.className = 'message tutor';
    
    let sourcesText = '';
    if (response.contextUsed && response.contextUsed.length > 0) {
      sourcesText = `<div class="tutor-sources"><strong>Quellen:</strong> ` + 
        response.contextUsed.map(s => `${s.title} (Score: ${(s.similarity * 100).toFixed(1)}%)`).join(', ') + 
        `</div>`;
    }

    tutorMsg.innerHTML = `
      <div>${response.answer}</div>
      ${sourcesText}
    `;
    chatMessages.appendChild(tutorMsg);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  } catch (err) {
    chatMessages.removeChild(thinkingMsg);
    alert('Fehler beim Abfragen des Tutors: ' + err.message);
  }
}

// Helper to format simple markdown highlights
function formatMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/^# (.*$)/gim, '<h1>$1</h1>')
    .replace(/^## (.*$)/gim, '<h2>$1</h2>')
    .replace(/^### (.*$)/gim, '<h3>$1</h3>')
    .replace(/\*\*(.*)\*\*/gim, '<strong>$1</strong>')
    .replace(/\*(.*)\*/gim, '<em>$1</em>')
    .replace(/```python([\s\S]*?)```/gim, '<pre><code class="language-python">$1</code></pre>')
    .replace(/```javascript([\s\S]*?)```/gim, '<pre><code class="language-javascript">$1</code></pre>')
    .replace(/```([\s\S]*?)```/gim, '<pre><code>$1</code></pre>')
    .replace(/\n/gim, '<br>');
}

// ==================== ADMIN LOGIC ====================

let adminPollInterval = null;

async function loadAdminDashboard() {
  try {
    const tableBody = document.getElementById('admin-courses-table-body');
    if (!tableBody) return;
    
    // Do not overwrite table if modal wizard is currently open or user is confirming delete
    const modal = document.getElementById('wizard-modal');
    if (modal && !modal.classList.contains('hidden')) {
      return; // Skip loading table to prevent input loss
    }
    if (state.isDeleting) {
      return; // Skip loading table to prevent dialog dismissal
    }

    const courses = await apiCall('/courses');

    // Re-check after await: a confirm/delete may have started while we were fetching
    if (state.isDeleting) {
      return;
    }
    const modalAfterFetch = document.getElementById('wizard-modal');
    if (modalAfterFetch && !modalAfterFetch.classList.contains('hidden')) {
      return;
    }
    
    tableBody.innerHTML = '';
    const sessionSelector = document.getElementById('verify-session-select');
    
    // Clear and reset session selector except first
    sessionSelector.innerHTML = '<option value="">Wähle eine Session zum Verifizieren...</option>';

    if (courses.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="4">Keine Kurse vorhanden. Erstelle oben deinen ersten Kurs!</td></tr>';
    } else {
      courses.forEach(course => {
        const row = document.createElement('tr');
        
        let statusLabels = '';
        if (course.status === 'generating') {
          const prog = course.progress || { percent: 0, step: 'Gestartet' };
          statusLabels = `
            <div style="width: 100%; max-width: 220px;">
              <span class="badge" style="background:#f59e0b20; color:#f59e0b; border:1px solid #f59e0b40; margin-bottom: 4px; display: inline-block; font-size: 0.75rem;">Wird generiert (${prog.percent}%)</span>
              <div style="font-size: 0.72rem; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px;" title="${prog.step}">${prog.step}</div>
              <div style="width: 100%; height: 4px; background: rgba(255,255,255,0.05); border-radius: 2px; margin-top: 4px; overflow: hidden;">
                <div style="width: ${prog.percent}%; height: 100%; background: linear-gradient(90deg, var(--accent-primary), var(--accent-secondary)); transition: width 0.4s ease;"></div>
              </div>
            </div>
          `;
        } else {
          statusLabels = {
            curriculum_draft: '<span class="badge" style="background:#8b5cf620; color:#a78bfa; border:1px solid #8b5cf640;">Lehrplan-Entwurf</span>',
            content_draft: '<span class="badge" style="background:#ec489920; color:#f472b6; border:1px solid #ec489940;">Inhalts-Entwurf</span>',
            pending_approval: '<span class="badge" style="background:#2563eb20; color:#3b82f6; border:1px solid #2563eb40;">Freigabe ausstehend</span>',
            active: '<span class="badge" style="background:#05966920; color:#10b981; border:1px solid #05966940;">Aktiv</span>',
            failed: '<span class="badge" style="background:#dc262620; color:#ef4444; border:1px solid #dc262640;">Fehlgeschlagen</span>',
          }[course.status];
        }

        let actionBtn = '';
        if (course.status === 'curriculum_draft' || course.status === 'content_draft') {
          actionBtn = `
            <div style="display: flex; gap: 8px;">
              <button class="btn btn-secondary btn-sm" onclick="openWizard('${course.id}', '${course.topic.replace(/'/g, "\\'")}', '${course.duration}')"><i data-lucide="edit-3"></i> Wizard bearbeiten</button>
              <button class="btn btn-sm" style="background:#dc262620; color:#ef4444; border:1px solid #dc262640;" onclick="handleDeleteCourse('${course.id}')"><i data-lucide="trash-2"></i> Löschen</button>
            </div>
          `;
        } else if (course.status === 'pending_approval') {
          actionBtn = `
            <div style="display: flex; gap: 8px;">
              <button class="btn btn-secondary btn-sm" onclick="openWizard('${course.id}', '${course.topic.replace(/'/g, "\\'")}', '${course.duration}')"><i data-lucide="edit-3"></i> Wizard</button>
              <button class="btn btn-primary btn-sm" onclick="handleApproveCourse('${course.id}')"><i data-lucide="check-square"></i> Freigeben</button>
              <button class="btn btn-sm" style="background:#dc262620; color:#ef4444; border:1px solid #dc262640;" onclick="handleDeleteCourse('${course.id}')"><i data-lucide="trash-2"></i> Löschen</button>
            </div>
          `;
        } else if (course.status === 'generating') {
          actionBtn = `
            <button class="btn btn-sm" style="background:#dc262620; color:#ef4444; border:1px solid #dc262640;" onclick="handleStopCourse('${course.id}')"><i data-lucide="square"></i> Stoppen</button>
          `;
        } else {
          actionBtn = `
            <div style="display: flex; gap: 8px; align-items: center;">
              ${course.status === 'active' ? '<span class="badge student">Freigegeben</span>' : ''}
              <button class="btn btn-secondary btn-sm" onclick="openWizard('${course.id}', '${course.topic.replace(/'/g, "\\'")}', '${course.duration}')"><i data-lucide="edit-3"></i> Inhalte nachziehen</button>
              <button class="btn btn-sm" style="background:#dc262620; color:#ef4444; border:1px solid #dc262640;" onclick="handleDeleteCourse('${course.id}')"><i data-lucide="trash-2"></i> Löschen</button>
            </div>
          `;
        }

        row.innerHTML = `
          <td><strong>${course.topic}</strong></td>
          <td>${statusLabels}</td>
          <td>${new Date(course.createdAt).toLocaleString()}</td>
          <td>${actionBtn}</td>
        `;
        tableBody.appendChild(row);
      });
    }

    // Load config values into form fields (avoid loading repeatedly if user is typing)
    const activeEl = document.activeElement;
    if (!activeEl || !activeEl.id.startsWith('cfg-')) {
      const config = await apiCall('/admin/config');
      document.getElementById('cfg-generate-video').value = config.GENERATE_VIDEO || 'false';
      document.getElementById('cfg-video-provider').value = config.VIDEO_PROVIDER || 'elevenlabs';
      document.getElementById('cfg-elevenlabs-tts-only').value = config.ELEVENLABS_TTS_ONLY || 'true';
      document.getElementById('cfg-llm-provider').value = config.LLM_PROVIDER || 'openrouter';
      document.getElementById('cfg-openrouter-model').value = config.OPENROUTER_MODEL || 'google/gemini-2.5-pro';
      document.getElementById('cfg-openrouter-key').value = config.OPENROUTER_API_KEY || '';
      document.getElementById('cfg-embedding-provider').value = config.EMBEDDING_PROVIDER || 'local';
      document.getElementById('cfg-vllm-url').value = config.vLLM_BASE_URL || 'http://localhost:8000/v1';
      document.getElementById('cfg-vllm-model').value = config.vLLM_MODEL || 'meta-llama/Meta-Llama-3-8B-Instruct';
      document.getElementById('cfg-elevenlabs-key').value = config.ELEVENLABS_API_KEY || '';
      document.getElementById('cfg-elevenlabs-voice').value = config.ELEVENLABS_VOICE_ID || '';
      document.getElementById('cfg-heygen-url').value = config.HEYGEN_API_URL || 'https://api.heygen.com';
      document.getElementById('cfg-heygen-key').value = config.HEYGEN_API_KEY || '';
    }
    
    // Load some mock/real session ids into the drop-down selector
    // For demonstration, fetch all activity logs globally (or we mock options)
    // To make it look beautiful, we populate the drop-down with the sessions registered
    // We will simulate a session ID or query sessions from the db.
    // Let's populate the selector with a few values for convenience
    // In our test suite, we will register sessions.
    const mockSessions = ['sess_demo_chain_123', 'sess_demo_chain_broken'];
    mockSessions.forEach(sess => {
      const opt = document.createElement('option');
      opt.value = sess;
      opt.textContent = sess;
      sessionSelector.appendChild(opt);
    });

    // Also populate with the student's session if active
    if (state.sessionId) {
      const opt = document.createElement('option');
      opt.value = state.sessionId;
      opt.textContent = `${state.sessionId} (Aktuelle Sitzung)`;
      sessionSelector.appendChild(opt);
    }

    lucide.createIcons();
  } catch (err) {
    console.error('Failed to load admin dashboard:', err.message);
  }
}

async function handleGenerateCourse(e) {
  e.preventDefault();
  const topic = document.getElementById('course-topic').value;
  const duration = document.getElementById('course-duration').value;
  if (!topic) return;

  document.getElementById('course-topic').value = '';

  try {
    const res = await apiCall('/courses/generate', {
      method: 'POST',
      body: JSON.stringify({ topic, duration }),
    });

    // Open wizard immediately at Step 1 for this new course
    openWizard(res.courseId, topic, duration);
  } catch (err) {
    alert('Fehler beim Initialisieren des Kursentwurfs: ' + err.message);
  }
}

async function handleApproveCourse(courseId) {
  try {
    await apiCall(`/courses/${courseId}/approve`, { method: 'POST' });
    alert('Kurs erfolgreich freigegeben! Er ist nun für Schüler sichtbar.');
    loadAdminDashboard();
  } catch (err) {
    alert('Fehler beim Freigeben des Kurses: ' + err.message);
  }
}

async function handleStopCourse(courseId) {
  if (!confirm('Möchtest du die Generierung dieses Kurses wirklich abbrechen?')) return;
  try {
    await apiCall(`/courses/${courseId}/cancel`, { method: 'POST' });
    alert('Kursgenerierung erfolgreich gestoppt.');
    loadAdminDashboard();
  } catch (err) {
    alert('Fehler beim Stoppen des Kurses: ' + err.message);
  }
}

async function handleDeleteCourse(courseId) {
  // Block dashboard polls before confirm so an in-flight table refresh
  // cannot destroy the button and auto-dismiss the native dialog.
  state.isDeleting = true;
  const ok = confirm('Möchtest du diesen Kurs wirklich unwiderruflich löschen? Alle Module, Lektionen und Lernzeiten werden gelöscht.');
  if (!ok) {
    state.isDeleting = false;
    return;
  }

  try {
    await apiCall(`/courses/${courseId}`, { method: 'DELETE' });
    alert('Kurs erfolgreich gelöscht.');
  } catch (err) {
    alert('Fehler beim Löschen des Kurses: ' + err.message);
  } finally {
    // Clear flag before refresh — otherwise loadAdminDashboard() bails out
    // early and the deleted row stays visible until the next poll.
    state.isDeleting = false;
  }
  loadAdminDashboard();
}

async function handleVerifyChain() {
  const select = document.getElementById('verify-session-select');
  const sessionId = select.value;
  if (!sessionId) {
    alert('Bitte wähle eine Session aus.');
    return;
  }

  const resultBox = document.getElementById('verification-result');
  resultBox.className = 'verification-box';
  resultBox.innerHTML = '<p>Kette wird geprüft...</p>';
  resultBox.classList.remove('hidden');

  try {
    // If it's the broken session demo, we simulate a failure to show the audit capacity
    if (sessionId === 'sess_demo_chain_broken') {
      setTimeout(() => {
        resultBox.classList.add('invalid');
        resultBox.innerHTML = `
          <div class="verification-title">
            <i data-lucide="alert-triangle"></i>
            Kette manipuliert! Verifizierung fehlgeschlagen.
          </div>
          <div class="verification-details">
            Sitzungs-ID: sess_demo_chain_broken<br>
            Fehler: Block #2 hat ein ungültiges previous_hash-Feld.<br>
            Erwarteter Hash: d6a8e8f...<br>
            Gefundener Hash: 9ca3af8...<br>
            Mögliche Manipulation: Datensätze wurden nachträglich eingefügt oder geändert!
          </div>
        `;
        lucide.createIcons();
      }, 800);
      return;
    }

    // Call API for verification
    const res = await apiCall(`/time-tracking/verify/${sessionId}`);
    
    if (res.valid) {
      resultBox.classList.add('valid');
      resultBox.innerHTML = `
        <div class="verification-title">
          <i data-lucide="check-circle"></i>
          Kette intakt. Daten sind revisionssicher!
        </div>
        <div class="verification-details">
          Sitzungs-ID: ${sessionId}<br>
          Geprüfte Heartbeats: ${res.count}<br>
          Gesamte Lernzeit: ${res.count * 10} Sekunden<br>
          Status: Alle kryptographischen Signaturen (SHA-256) stimmen überein.
        </div>
      `;
    } else {
      resultBox.classList.add('invalid');
      resultBox.innerHTML = `
        <div class="verification-title">
          <i data-lucide="alert-triangle"></i>
          Kette manipuliert! Verifizierung fehlgeschlagen.
        </div>
        <div class="verification-details">
          Sitzungs-ID: ${sessionId}<br>
          Manipulierter Block-Index: #${res.tamperedIndex}<br>
          Geprüfte Blöcke: ${res.count}<br>
          Mögliche Manipulation: Zeitstempel oder Aktivitätsdauern wurden direkt in der Datenbank verändert!
        </div>
      `;
    }
    lucide.createIcons();
  } catch (err) {
    resultBox.className = 'verification-box invalid';
    resultBox.innerHTML = `<p>Fehler bei der Verifizierung: ${err.message}</p>`;
  }
}

function startAdminPolling() {
  stopAdminPolling();
  // Poll admin dashboard table every 5 seconds
  adminPollInterval = setInterval(loadAdminDashboard, 5000);
}

function stopAdminPolling() {
  if (adminPollInterval) {
    clearInterval(adminPollInterval);
    adminPollInterval = null;
  }
}

async function handleSaveConfig(e) {
  e.preventDefault();
  
  const payload = {
    GENERATE_VIDEO: document.getElementById('cfg-generate-video').value,
    VIDEO_PROVIDER: document.getElementById('cfg-video-provider').value,
    ELEVENLABS_TTS_ONLY: document.getElementById('cfg-elevenlabs-tts-only').value,
    LLM_PROVIDER: document.getElementById('cfg-llm-provider').value,
    OPENROUTER_MODEL: document.getElementById('cfg-openrouter-model').value,
    OPENROUTER_API_KEY: document.getElementById('cfg-openrouter-key').value,
    EMBEDDING_PROVIDER: document.getElementById('cfg-embedding-provider').value,
    vLLM_BASE_URL: document.getElementById('cfg-vllm-url').value,
    vLLM_MODEL: document.getElementById('cfg-vllm-model').value,
    ELEVENLABS_API_KEY: document.getElementById('cfg-elevenlabs-key').value,
    ELEVENLABS_VOICE_ID: document.getElementById('cfg-elevenlabs-voice').value,
    HEYGEN_API_URL: document.getElementById('cfg-heygen-url').value,
    HEYGEN_API_KEY: document.getElementById('cfg-heygen-key').value,
  };

  try {
    await apiCall('/admin/config', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    alert('KI-Konfiguration erfolgreich gespeichert und auf Server geladen!');
    loadAdminDashboard();
  } catch (err) {
    alert('Fehler beim Speichern der Konfiguration: ' + err.message);
  }
}

function toggleConfigPanel() {
  const content = document.getElementById('config-collapse-content');
  const chevron = document.getElementById('config-chevron');
  const isHidden = content.classList.contains('hidden');
  
  if (isHidden) {
    content.classList.remove('hidden');
    chevron.style.transform = 'rotate(180deg)';
  } else {
    content.classList.add('hidden');
    chevron.style.transform = 'rotate(0deg)';
  }
}

async function handleTestOpenRouter() {
  const apiKey = document.getElementById('cfg-openrouter-key').value;
  const statusDiv = document.getElementById('openrouter-test-status');
  const btn = document.getElementById('btn-test-openrouter');
  
  if (!apiKey) {
    statusDiv.style.color = '#ff6b6b';
    statusDiv.textContent = 'Bitte zuerst einen Key eintragen!';
    statusDiv.style.display = 'block';
    return;
  }

  statusDiv.style.color = '#aaa';
  statusDiv.textContent = 'Verbindung wird getestet...';
  statusDiv.style.display = 'block';
  btn.disabled = true;

  try {
    const res = await apiCall('/admin/config/test-openrouter', {
      method: 'POST',
      body: JSON.stringify({ apiKey }),
    });

    if (res.success) {
      statusDiv.style.color = '#51cf66';
      statusDiv.innerHTML = `<i class="inline-icon" data-lucide="check-circle" style="width:12px;height:12px;display:inline-block;vertical-align:middle;margin-right:4px;"></i> Verbindung erfolgreich! Key-Label: <strong>${res.label}</strong> (Verbrauch: ${res.usage} USD)`;
    } else {
      statusDiv.style.color = '#ff6b6b';
      statusDiv.textContent = 'Fehler: ' + (res.error || 'Verbindung fehlgeschlagen.');
    }
  } catch (err) {
    statusDiv.style.color = '#ff6b6b';
    statusDiv.textContent = 'Fehler: ' + err.message;
  } finally {
    btn.disabled = false;
    lucide.createIcons();
  }
}

async function handleTestElevenLabs() {
  const apiKey = document.getElementById('cfg-elevenlabs-key').value;
  const voiceId = document.getElementById('cfg-elevenlabs-voice').value;
  const statusDiv = document.getElementById('elevenlabs-test-status');
  const btn = document.getElementById('btn-test-elevenlabs');

  if (!apiKey) {
    statusDiv.style.color = '#ff6b6b';
    statusDiv.textContent = 'Bitte zuerst einen Key eintragen!';
    statusDiv.style.display = 'block';
    return;
  }

  statusDiv.style.color = '#aaa';
  statusDiv.textContent = 'Verbindung zu ElevenLabs wird getestet...';
  statusDiv.style.display = 'block';
  btn.disabled = true;

  try {
    const res = await apiCall('/admin/config/test-elevenlabs', {
      method: 'POST',
      body: JSON.stringify({ apiKey, voiceId }),
    });

    if (res.success) {
      statusDiv.style.color = '#51cf66';
      statusDiv.innerHTML = `<i class="inline-icon" data-lucide="check-circle" style="width:12px;height:12px;display:inline-block;vertical-align:middle;margin-right:4px;"></i> Verbindung erfolgreich! Stimme: <strong>${res.voiceName}</strong> (Verbrauch: ${res.characterCount.toLocaleString()} / ${res.characterLimit.toLocaleString()} Zeichen)`;
    } else {
      statusDiv.style.color = '#ff6b6b';
      statusDiv.textContent = 'Fehler: ' + (res.error || 'Verbindung fehlgeschlagen.');
    }
  } catch (err) {
    statusDiv.style.color = '#ff6b6b';
    statusDiv.textContent = 'Fehler: ' + err.message;
  } finally {
    btn.disabled = false;
    lucide.createIcons();
  }
}

async function loadUsageStats() {
  const orEl = document.getElementById('stat-openrouter-usage');
  const elEl = document.getElementById('stat-elevenlabs-usage');
  if (!orEl || !elEl) return;

  try {
    const data = await apiCall('/admin/usage');
    orEl.textContent = data.openrouter.usage;
    if (data.openrouter.label) {
      orEl.innerHTML = `${data.openrouter.usage} <span style="font-size: 0.75rem; font-weight: normal; color: var(--text-secondary);">(${data.openrouter.label})</span>`;
    }
    elEl.textContent = data.elevenlabs.usage;
  } catch (err) {
    console.error('Failed to load usage stats:', err);
    orEl.textContent = 'Fehler beim Laden';
    elEl.textContent = 'Fehler beim Laden';
  }
}

// ==================== WIZARD & SLIDES IMPLEMENTATION ====================
let wizardState = {
  courseId: null,
  currentStep: 1, // 1, 2, 3
  topic: '',
  duration: '2_weeks',
  curriculumData: null, // Full module & lesson object fetched from course details
  activeLessonId: null,
  pollInterval: null
};

async function openWizard(courseId, topic = '', duration = '2_weeks') {
  wizardState.courseId = courseId;
  wizardState.currentStep = 1;
  wizardState.topic = topic;
  wizardState.duration = duration || '2_weeks';
  wizardState.curriculumData = null;
  wizardState.activeLessonId = null;

  // Show modal
  const modal = document.getElementById('wizard-modal');
  modal.classList.remove('hidden');

  // Fill in default curriculum prompt
  document.getElementById('wz-prompt-step1').value = `Erstelle einen didaktischen Lehrplan zum Thema "${topic}".`;

  // Fetch existing course status to see if it's already in step 1 or step 2 draft
  try {
    const courseDetails = await apiCall(`/courses/${courseId}`);
    wizardState.curriculumData = courseDetails;
    wizardState.topic = courseDetails.course.topic || topic;
    // courses table has no duration column — keep the value from openWizard()/form
    const savedDuration = courseDetails.course?.progress?.duration;
    wizardState.duration = savedDuration || duration || '2_weeks';

    // Update prompt with the fetched topic
    document.getElementById('wz-prompt-step1').value = `Erstelle einen didaktischen Lehrplan zum Thema "${wizardState.topic}".`;

    const hasModules = courseDetails.modules && courseDetails.modules.length > 0;
    const hasLessonText = (courseDetails.lessons || []).some(
      (l) => l.contentPayload && l.contentPayload.text_content && l.contentPayload.text_content.trim()
    );

    if (!hasModules) {
      goToWizardStep(1);
      wizardRegenerateCurriculum();
    } else if (!hasLessonText || courseDetails.course.status === 'content_draft') {
      // Curriculum exists but theory/scripts missing (often after skipping Step 2)
      goToWizardStep(2);
      syncWizardStep2Ui(courseDetails);
    } else {
      goToWizardStep(1);
    }
  } catch (err) {
    // If new draft, auto-trigger step 1 curriculum generation
    goToWizardStep(1);
    wizardRegenerateCurriculum();
  }
}

function syncWizardStep2Ui(details) {
  const btn = document.getElementById('wz-btn-regen-step2');
  const progressBox = document.getElementById('wz-step2-progress-box');
  if (!btn || !progressBox) return;

  const status = details?.course?.status;
  const prog = details?.course?.progress || {};
  const done = status === 'content_draft' || status === 'pending_approval' || status === 'active'
    || prog.percent >= 80
    || (prog.step && /generiert/i.test(prog.step));

  if (done) {
    if (wizardState.pollInterval) {
      clearInterval(wizardState.pollInterval);
      wizardState.pollInterval = null;
    }
    progressBox.classList.remove('hidden');
    document.getElementById('wz-progress-step-text').textContent = prog.step || 'Lektionsinhalte generiert.';
    document.getElementById('wz-progress-step-percent').textContent = '100%';
    document.getElementById('wz-progress-step-bar').style.width = '100%';
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="check-circle-2"></i> Fertig – ggf. erneut generieren';
    lucide.createIcons();
    wizardState.curriculumData = details;
    renderStep2Content();
  } else if (status === 'generating') {
    // Resume polling if generation is still running in the background
    progressBox.classList.remove('hidden');
    document.getElementById('wz-progress-step-text').textContent = prog.step || 'Generiere Lektionsinhalte...';
    document.getElementById('wz-progress-step-percent').textContent = `${prog.percent || 0}%`;
    document.getElementById('wz-progress-step-bar').style.width = `${prog.percent || 0}%`;
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="refresh-cw" class="spin"></i> Generiere Inhalte...';
    lucide.createIcons();
    startStep2ProgressPolling();
  } else {
    progressBox.classList.add('hidden');
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="refresh-cw"></i> Lektionsinhalte (re)generieren';
    lucide.createIcons();
  }
}

function startStep2ProgressPolling() {
  const btn = document.getElementById('wz-btn-regen-step2');
  const progressBox = document.getElementById('wz-step2-progress-box');
  if (wizardState.pollInterval) clearInterval(wizardState.pollInterval);

  wizardState.pollInterval = setInterval(async () => {
    try {
      const details = await apiCall(`/courses/${wizardState.courseId}`);
      const prog = details.course.progress || { percent: 25, step: 'Generiere Lektionsinhalte...' };

      document.getElementById('wz-progress-step-text').textContent = prog.step;
      document.getElementById('wz-progress-step-percent').textContent = `${prog.percent}%`;
      document.getElementById('wz-progress-step-bar').style.width = `${prog.percent}%`;

      const done = details.course.status === 'content_draft'
        || details.course.status === 'pending_approval'
        || details.course.status === 'active'
        || prog.percent >= 80
        || (prog.step && /generiert/i.test(prog.step));

      if (done) {
        clearInterval(wizardState.pollInterval);
        wizardState.pollInterval = null;
        syncWizardStep2Ui(details);
        return;
      }

      if (details.course.status === 'failed') {
        clearInterval(wizardState.pollInterval);
        wizardState.pollInterval = null;
        alert('Die Generierung ist fehlgeschlagen: ' + prog.step);
        progressBox.classList.add('hidden');
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="refresh-cw"></i> Lektionsinhalte (re)generieren';
        lucide.createIcons();
      }
    } catch (pollErr) {
      console.error('Error polling content generation progress:', pollErr);
      // Stop polling on auth/session errors so the UI doesn't stay stuck forever
      if (String(pollErr.message || '').includes('Sitzung abgelaufen')) {
        clearInterval(wizardState.pollInterval);
        wizardState.pollInterval = null;
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="refresh-cw"></i> Lektionsinhalte (re)generieren';
        lucide.createIcons();
      }
    }
  }, 2000);
}

function closeWizard() {
  if (wizardState.pollInterval) {
    clearInterval(wizardState.pollInterval);
    wizardState.pollInterval = null;
  }
  document.getElementById('wizard-modal').classList.add('hidden');
  loadAdminDashboard();
}

function goToWizardStep(step) {
  wizardState.currentStep = step;

  // Update progress nodes
  document.getElementById('node-step1').classList.toggle('active', step >= 1);
  document.getElementById('node-step2').classList.toggle('active', step >= 2);
  document.getElementById('node-step3').classList.toggle('active', step >= 3);

  // Set node circles borders/backgrounds
  document.querySelector('#node-step1 .node-circle').style.borderColor = step >= 1 ? 'var(--accent-primary)' : 'rgba(255,255,255,0.1)';
  document.querySelector('#node-step2 .node-circle').style.borderColor = step >= 2 ? 'var(--accent-primary)' : 'rgba(255,255,255,0.1)';
  document.querySelector('#node-step3 .node-circle').style.borderColor = step >= 3 ? 'var(--accent-primary)' : 'rgba(255,255,255,0.1)';

  // Update line progress bar
  const pct = (step - 1) * 50;
  document.getElementById('wizard-progress-bar').style.width = `${pct}%`;

  // Show/Hide panes
  document.getElementById('wizard-pane-step1').classList.toggle('hidden', step !== 1);
  document.getElementById('wizard-pane-step2').classList.toggle('hidden', step !== 2);
  document.getElementById('wizard-pane-step3').classList.toggle('hidden', step !== 3);

  // Update footer button states
  document.getElementById('wz-btn-prev').disabled = step === 1;
  
  const nextBtn = document.getElementById('wz-btn-next');
  if (step === 3) {
    nextBtn.textContent = 'Fertig';
    nextBtn.onclick = () => closeWizard();
  } else {
    nextBtn.textContent = 'Weiter';
    nextBtn.onclick = () => wizardNextStep();
  }

  // Populate content depending on the step
  if (step === 1) {
    renderStep1Curriculum();
  } else if (step === 2) {
    renderStep2Content();
  }

  lucide.createIcons();
}

function wizardNextStep() {
  if (wizardState.currentStep === 1) {
    // Save current step 1 state to DB before proceeding
    wizardSaveStep1(() => goToWizardStep(2));
  } else if (wizardState.currentStep === 2) {
    goToWizardStep(3);
  }
}

function wizardPrevStep() {
  if (wizardState.currentStep > 1) {
    goToWizardStep(wizardState.currentStep - 1);
  }
}

// STEP 1: Curriculum Generation & Interactive Editing
async function wizardRegenerateCurriculum() {
  const btn = document.getElementById('wz-btn-regen-step1');
  const editor = document.getElementById('wz-curriculum-editor');
  const prompt = document.getElementById('wz-prompt-step1').value;

  if (btn.dataset.busy === '1') return;
  btn.dataset.busy = '1';
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="refresh-cw" class="spin"></i> Generiere Lehrplan…';
  if (editor) {
    editor.innerHTML = `
      <div style="text-align:center; padding:28px 16px; color:var(--text-secondary);">
        <i data-lucide="loader-2" class="spin" style="width:28px;height:28px;margin-bottom:12px;"></i>
        <p style="margin:0 0 6px; color:#fff; font-weight:600;">Lehrplan wird mit der KI generiert…</p>
        <p style="margin:0; font-size:0.85rem;">Das kann 30–90 Sekunden dauern. Bitte warten.</p>
      </div>`;
  }
  lucide.createIcons();

  try {
    await apiCall('/courses/wizard/step1-curriculum', {
      method: 'POST',
      body: JSON.stringify({
        courseId: wizardState.courseId,
        topic: wizardState.topic,
        duration: wizardState.duration || '2_weeks',
        customPrompt: prompt
      })
    });

    // Fetch updated details from DB
    const courseDetails = await apiCall(`/courses/${wizardState.courseId}`);
    wizardState.curriculumData = courseDetails;
    renderStep1Curriculum();
  } catch (err) {
    if (editor) {
      editor.innerHTML = `<p style="color:#ef4444; text-align:center; padding:20px;">Fehler: ${err.message}</p>`;
    }
    alert('Fehler beim Generieren des Lehrplans: ' + err.message);
  } finally {
    btn.dataset.busy = '0';
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="refresh-cw"></i> Curriculum regenerieren';
    lucide.createIcons();
  }
}

function renderStep1Curriculum() {
  const container = document.getElementById('wz-curriculum-editor');
  container.innerHTML = '';

  if (!wizardState.curriculumData || wizardState.curriculumData.modules.length === 0) {
    container.innerHTML = '<p style="color: var(--text-secondary); text-align: center; padding: 20px;">Noch kein Lehrplan generiert. Klicke oben auf "Curriculum regenerieren".</p>';
    return;
  }

  wizardState.curriculumData.modules.forEach((mod, modIdx) => {
    const modCard = document.createElement('div');
    modCard.className = 'glass-card';
    modCard.style.padding = '16px';
    modCard.style.background = 'rgba(255,255,255,0.02)';
    modCard.style.border = '1px solid rgba(255,255,255,0.06)';

    // Module Title input
    modCard.innerHTML = `
      <div class="form-group" style="margin-bottom: 12px;">
        <label style="font-size: 0.75rem; text-transform: uppercase;">Modul ${modIdx + 1}</label>
        <input type="text" class="wz-mod-title-input" data-mod-id="${mod.id}" value="${mod.title}" style="font-weight: bold; font-size: 1.05rem; background: rgba(0,0,0,0.15); border: 1px solid rgba(255,255,255,0.08); padding: 6px 10px; border-radius: 4px; color: #fff; width: 100%;">
      </div>
      <div class="wz-lessons-container" style="display: flex; flex-direction: column; gap: 16px; padding-left: 16px; border-left: 2px solid rgba(255,255,255,0.05);">
        <!-- Lessons here -->
      </div>
    `;

    const lessonsContainer = modCard.querySelector('.wz-lessons-container');
    const modLessons = wizardState.curriculumData.lessons.filter(l => l.moduleId === mod.id);

    modLessons.forEach((les, lesIdx) => {
      const payload = les.contentPayload || {};
      const slides = payload.slides || [];

      const lesCard = document.createElement('div');
      lesCard.style.padding = '12px';
      lesCard.style.background = 'rgba(0,0,0,0.1)';
      lesCard.style.borderRadius = '6px';
      lesCard.style.border = '1px solid rgba(255,255,255,0.04)';

      let slidesHtml = '';
      slides.forEach((slide, sIdx) => {
        slidesHtml += `
          <div class="wz-slide-edit-block" style="margin-top: 8px; padding: 8px; background: rgba(255,255,255,0.02); border-radius: 4px; border: 1px solid rgba(255,255,255,0.04);">
            <div style="font-size: 0.72rem; color: var(--accent-primary); font-weight: 600; margin-bottom: 4px;">Folie ${sIdx + 1}</div>
            <input type="text" class="wz-slide-title-input" data-lesson-id="${les.id}" data-slide-index="${sIdx}" value="${slide.title}" placeholder="Titel der Folie" style="font-size: 0.85rem; padding: 4px 8px; margin-bottom: 4px; width: 100%; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.08); border-radius: 4px; color: #fff;">
            <textarea class="wz-slide-bullets-input" data-lesson-id="${les.id}" data-slide-index="${sIdx}" placeholder="Stichpunkte (jeder Stichpunkt in eine neue Zeile)" style="font-size: 0.8rem; padding: 4px 8px; width: 100%; height: 60px; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.08); border-radius: 4px; color: #fff; resize: vertical; font-family: inherit;">${(slide.bullets || []).join('\n')}</textarea>
          </div>
        `;
      });

      lesCard.innerHTML = `
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 8px;">
          <div class="form-group" style="margin-bottom:0;">
            <label style="font-size: 0.7rem; color: var(--text-secondary);">Lektion ${lesIdx + 1} Titel</label>
            <input type="text" class="wz-les-title-input" data-les-id="${les.id}" value="${les.title}" style="background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.08); padding: 4px 8px; border-radius: 4px; color: #fff; width: 100%; font-size: 0.9rem;">
          </div>
          <div class="form-group" style="margin-bottom:0;">
            <label style="font-size: 0.7rem; color: var(--text-secondary);">Lernzeit (Minuten)</label>
            <input type="number" class="wz-les-duration-input" data-les-id="${les.id}" value="${payload.estimated_duration_minutes || 15}" style="background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.08); padding: 4px 8px; border-radius: 4px; color: #fff; width: 100%; font-size: 0.9rem;">
          </div>
        </div>
        <div class="form-group" style="margin-bottom:8px;">
          <label style="font-size: 0.7rem; color: var(--text-secondary);">Kurzbeschreibung</label>
          <input type="text" class="wz-les-desc-input" data-les-id="${les.id}" value="${payload.description || ''}" style="background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.08); padding: 4px 8px; border-radius: 4px; color: #fff; width: 100%; font-size: 0.85rem;">
        </div>
        <div class="wz-slides-wrapper">
          <div style="font-size: 0.75rem; font-weight: 500; color: var(--text-secondary); margin-top: 8px;">Präsentations-Folien (Bullet Points)</div>
          ${slidesHtml}
        </div>
      `;
      lessonsContainer.appendChild(lesCard);
    });

    container.appendChild(modCard);
  });
}

async function wizardSaveStep1(callback = null) {
  // Read inputs from DOM
  const modulesData = [];
  const modulesList = document.querySelectorAll('.wz-mod-title-input');
  
  modulesList.forEach(modInput => {
    const modId = modInput.dataset.modId;
    const modTitle = modInput.value;
    const lessonsData = [];

    // Find lessons belonging to this module
    const lessonsInputs = modInput.closest('.glass-card').querySelectorAll('.wz-les-title-input');
    lessonsInputs.forEach(lesInput => {
      const lesId = lesInput.dataset.lesId;
      const lesTitle = lesInput.value;
      const lesCard = lesInput.closest('div').parentElement.parentElement;
      const duration = parseInt(lesCard.querySelector('.wz-les-duration-input').value) || 15;
      const description = lesCard.querySelector('.wz-les-desc-input').value;

      // Slides
      const slides = [];
      const slideTitleInputs = lesCard.querySelectorAll('.wz-slide-title-input');
      slideTitleInputs.forEach(slideInput => {
        const idx = parseInt(slideInput.dataset.slideIndex);
        const slideTitle = slideInput.value;
        const bulletsText = slideInput.nextElementSibling.value;
        const bullets = bulletsText.split('\n').map(b => b.trim()).filter(b => b.length > 0);

        slides[idx] = { title: slideTitle, bullets };
      });

      lessonsData.push({
        id: lesId,
        title: lesTitle,
        description,
        estimated_duration_minutes: duration,
        slides
      });
    });

    modulesData.push({
      id: modId,
      title: modTitle,
      lessons: lessonsData
    });
  });

  try {
    await apiCall('/courses/wizard/save-curriculum', {
      method: 'PUT',
      body: JSON.stringify({
        courseId: wizardState.courseId,
        title: wizardState.topic,
        modules: modulesData
      })
    });

    if (callback) callback();
  } catch (err) {
    alert('Fehler beim Speichern des Lehrplans: ' + err.message);
  }
}

// STEP 2: Lesson Text, Quiz and Teleprompter Script generation & edit
async function wizardGenerateLessonsContent() {
  const btn = document.getElementById('wz-btn-regen-step2');
  const prompt = document.getElementById('wz-prompt-step2').value;
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="refresh-cw" class="spin"></i> Generiere Inhalte...';
  lucide.createIcons();

  // Show progress box
  const progressBox = document.getElementById('wz-step2-progress-box');
  progressBox.classList.remove('hidden');
  document.getElementById('wz-progress-step-text').textContent = 'Starte Inhaltsgenerierung...';
  document.getElementById('wz-progress-step-percent').textContent = '0%';
  document.getElementById('wz-progress-step-bar').style.width = '0%';

  try {
    await apiCall('/courses/wizard/step2-content', {
      method: 'POST',
      body: JSON.stringify({
        courseId: wizardState.courseId,
        customPrompt: prompt
      })
    });

    startStep2ProgressPolling();
  } catch (err) {
    alert('Fehler beim Starten der Inhaltsgenerierung: ' + err.message);
    progressBox.classList.add('hidden');
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="refresh-cw"></i> Lektionsinhalte (re)generieren';
    lucide.createIcons();
  }
}

function renderStep2Content() {
  const lessonsList = document.getElementById('wz-lessons-list');
  lessonsList.innerHTML = '';

  if (!wizardState.curriculumData || wizardState.curriculumData.modules.length === 0) {
    lessonsList.innerHTML = '<p style="color: var(--text-secondary); text-align: center; padding: 20px;">Zuerst Schritt 1 abschließen.</p>';
    return;
  }

  // Populate left side accordion
  wizardState.curriculumData.modules.forEach(mod => {
    const modGroup = document.createElement('div');
    modGroup.className = 'module-group';
    modGroup.innerHTML = `<h6 style="margin-bottom:4px; font-size: 0.8rem; color: var(--accent-secondary);">${mod.title}</h6>`;

    const ul = document.createElement('ul');
    ul.className = 'lessons-list';

    const modLessons = wizardState.curriculumData.lessons.filter(l => l.moduleId === mod.id);
    modLessons.forEach(les => {
      const li = document.createElement('li');
      li.className = 'lesson-item';
      li.style.padding = '8px 12px';
      li.style.fontSize = '0.8rem';
      li.dataset.lesId = les.id;
      li.onclick = () => wizardSelectLessonForEdit(les.id);
      li.innerHTML = `
        <i data-lucide="file-text" style="width: 14px; height: 14px;"></i>
        <span>${les.title}</span>
      `;
      ul.appendChild(li);
    });

    modGroup.appendChild(ul);
    lessonsList.appendChild(modGroup);
  });

  lucide.createIcons();

  // Load first lesson if available
  if (wizardState.curriculumData.lessons.length > 0) {
    wizardSelectLessonForEdit(wizardState.curriculumData.lessons[0].id);
  }
}

function wizardSelectLessonForEdit(lessonId) {
  wizardState.activeLessonId = lessonId;
  
  // Highlight active
  document.querySelectorAll('#wz-lessons-list .lesson-item').forEach(item => {
    item.classList.toggle('active', item.dataset.lesId === lessonId);
  });

  const lesson = wizardState.curriculumData.lessons.find(l => l.id === lessonId);
  const panel = document.getElementById('wz-lesson-editor-panel');
  
  if (!lesson) {
    panel.innerHTML = '<p style="color: var(--text-secondary); text-align: center;">Lektion nicht gefunden.</p>';
    return;
  }

  const payload = lesson.contentPayload || {};
  const textContent = payload.text_content || '';
  const script = payload.teleprompter_script || '';
  const quiz = payload.quiz || [];

  let quizHtml = '';
  quiz.forEach((q, idx) => {
    quizHtml += `
      <div class="wz-quiz-edit-block" style="padding: 8px; margin-top: 8px; background: rgba(0,0,0,0.1); border-radius: 6px; border: 1px solid rgba(255,255,255,0.04);">
        <div style="font-size: 0.75rem; color: var(--accent-secondary); font-weight: 600; margin-bottom: 4px;">Frage ${idx + 1}</div>
        <input type="text" class="wz-q-question" value="${q.question}" placeholder="Frage" style="width: 100%; font-size: 0.8rem; padding: 4px 8px; margin-bottom: 4px; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.08); border-radius: 4px; color: #fff;">
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin-bottom: 4px;">
          <input type="text" class="wz-q-opt" data-opt-idx="0" value="${q.options[0] || ''}" placeholder="Option A" style="font-size: 0.75rem; padding: 2px 6px; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.08); border-radius: 4px; color: #fff;">
          <input type="text" class="wz-q-opt" data-opt-idx="1" value="${q.options[1] || ''}" placeholder="Option B" style="font-size: 0.75rem; padding: 2px 6px; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.08); border-radius: 4px; color: #fff;">
          <input type="text" class="wz-q-opt" data-opt-idx="2" value="${q.options[2] || ''}" placeholder="Option C" style="font-size: 0.75rem; padding: 2px 6px; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.08); border-radius: 4px; color: #fff;">
          <input type="text" class="wz-q-opt" data-opt-idx="3" value="${q.options[3] || ''}" placeholder="Option D" style="font-size: 0.75rem; padding: 2px 6px; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.08); border-radius: 4px; color: #fff;">
        </div>
        <div style="display: grid; grid-template-columns: 1fr 2fr; gap: 8px; align-items: center;">
          <div>
            <label style="font-size: 0.7rem; color: var(--text-secondary);">Richtige Option Index (0-3)</label>
            <input type="number" class="wz-q-correct" min="0" max="3" value="${q.correct_option_index}" style="width: 50px; font-size: 0.75rem; padding: 2px 6px; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.08); border-radius: 4px; color: #fff;">
          </div>
          <div>
            <label style="font-size: 0.7rem; color: var(--text-secondary);">Erklärung</label>
            <input type="text" class="wz-q-explain" value="${q.explanation}" placeholder="Warum richtig?" style="width: 100%; font-size: 0.75rem; padding: 2px 6px; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.08); border-radius: 4px; color: #fff;">
          </div>
        </div>
      </div>
    `;
  });

  panel.innerHTML = `
    <h4 style="font-size: 1rem; color: #fff; margin-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 8px;">"${lesson.title}" bearbeiten</h4>
    
    <div class="form-group" style="margin-bottom:12px;">
      <label style="font-size:0.75rem; color:var(--text-secondary);">Ausführliche Theorie (Markdown-Text)</label>
      <textarea id="wz-les-theory-edit" style="width: 100%; height: 180px; font-family: inherit; font-size: 0.85rem; padding: 8px; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; color: #fff; resize: vertical;">${textContent}</textarea>
    </div>

    <div class="form-group" style="margin-bottom:12px;">
      <label style="font-size:0.75rem; color:var(--text-secondary);">Teleprompter-Sprechskript (Für ElevenLabs / Avatar)</label>
      <textarea id="wz-les-script-edit" style="width: 100%; height: 120px; font-family: inherit; font-size: 0.85rem; padding: 8px; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; color: #fff; resize: vertical;">${script}</textarea>
    </div>

    <div class="form-group" style="margin-bottom:16px;">
      <label style="font-size:0.75rem; color:var(--text-secondary); margin-bottom:4px; display:block;">Wissenstest (Quizfragen)</label>
      <div class="wz-quiz-container">
        ${quizHtml || '<p style="font-size:0.8rem; color:var(--text-secondary);">Keine Fragen vorhanden.</p>'}
      </div>
    </div>

    <button class="btn btn-primary btn-sm" onclick="wizardSaveLessonEdits('${lessonId}')">
      Lektionsinhalte speichern <i data-lucide="save"></i>
    </button>
  `;

  lucide.createIcons();
}

async function wizardSaveLessonEdits(lessonId) {
  const textContent = document.getElementById('wz-les-theory-edit').value;
  const teleprompterScript = document.getElementById('wz-les-script-edit').value;
  
  // Read quiz edits
  const quiz = [];
  const quizBlocks = document.querySelectorAll('.wz-quiz-edit-block');
  quizBlocks.forEach(block => {
    const question = block.querySelector('.wz-q-question').value;
    const optionInputs = block.querySelectorAll('.wz-q-opt');
    const options = [];
    optionInputs.forEach(optIn => {
      const idx = parseInt(optIn.dataset.optIdx);
      options[idx] = optIn.value;
    });
    const correct_option_index = parseInt(block.querySelector('.wz-q-correct').value) || 0;
    const explanation = block.querySelector('.wz-q-explain').value;

    quiz.push({ question, options, correct_option_index, explanation });
  });

  try {
    await apiCall('/courses/wizard/save-lesson', {
      method: 'PUT',
      body: JSON.stringify({
        lessonId,
        textContent,
        teleprompterScript,
        quiz
      })
    });

    // Update local copy
    const les = wizardState.curriculumData.lessons.find(l => l.id === lessonId);
    if (les) {
      const payload = les.contentPayload || {};
      les.contentPayload = {
        ...payload,
        text_content: textContent,
        teleprompter_script: teleprompterScript,
        quiz
      };
    }
    
    alert('Lektionsinhalte erfolgreich gespeichert!');
  } catch (err) {
    alert('Fehler beim Speichern der Lektionsänderungen: ' + err.message);
  }
}

// STEP 3: Media rendering trigger
async function wizardTriggerMediaRendering() {
  try {
    await apiCall('/courses/wizard/step3-media', {
      method: 'POST',
      body: JSON.stringify({ courseId: wizardState.courseId })
    });

    alert('Medien-Rendering (ElevenLabs Audio) erfolgreich über Temporal gestartet!');
    closeWizard();
  } catch (err) {
    alert('Fehler beim Starten des Medien-Renderings: ' + err.message);
  }
}

// ==================== INTERACTIVE CLASSROOM SLIDES VIEW ====================
let classroomSlideState = {
  slides: [],
  currentIndex: 0
};

function isAudioOnlyUrl(url) {
  if (!url) return true;
  return /\.mp3($|\?)/i.test(url) || url.startsWith('/audio/');
}

function renderSlideStage() {
  const titleEl = document.getElementById('slide-stage-title');
  const bulletsEl = document.getElementById('slide-stage-bullets');
  const counterEl = document.getElementById('slide-stage-counter');
  if (!titleEl || !bulletsEl || !counterEl) return;

  const slides = classroomSlideState.slides || [];
  if (slides.length === 0) {
    titleEl.textContent = state.activeLesson?.title || 'Lektion';
    bulletsEl.innerHTML = '<li>Keine Folien für diese Lektion vorhanden.</li>';
    counterEl.textContent = 'Keine Folien';
    return;
  }

  const idx = Math.min(classroomSlideState.currentIndex, slides.length - 1);
  const slide = slides[idx];
  titleEl.textContent = slide.title || `Folie ${idx + 1}`;
  bulletsEl.innerHTML = '';
  (slide.bullets || []).forEach((b) => {
    const li = document.createElement('li');
    li.textContent = b;
    bulletsEl.appendChild(li);
  });
  counterEl.textContent = `Folie ${idx + 1} von ${slides.length}`;
}

function syncSlidesToMediaTime(player) {
  const slides = classroomSlideState.slides || [];
  if (!player || slides.length === 0 || !player.duration || !isFinite(player.duration)) return;
  const segment = player.duration / slides.length;
  const nextIndex = Math.min(slides.length - 1, Math.floor(player.currentTime / segment));
  if (nextIndex !== classroomSlideState.currentIndex) {
    classroomSlideState.currentIndex = nextIndex;
    renderActiveSlide();
    renderSlideStage();
  }
}

function setupLessonMediaPlayer(lesson) {
  const player = document.getElementById('avatar-video-player');
  const container = document.getElementById('lesson-media-container');
  const mediaLabel = document.getElementById('slide-stage-media-label');
  if (!player || !container) return;

  player.pause();
  player.removeAttribute('poster');

  const url = lesson.videoUrl || '';
  const audioOnly = isAudioOnlyUrl(url);
  container.classList.toggle('audio-mode', audioOnly);
  container.classList.toggle('video-mode', !audioOnly && !!url);

  if (mediaLabel) {
    mediaLabel.textContent = audioOnly ? 'ElevenLabs Audio + Folien' : 'Avatar-Video';
  }

  player.removeAttribute('src');
  while (player.firstChild) player.removeChild(player.firstChild);

  if (url) {
    const source = document.createElement('source');
    source.src = `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;
    source.type = audioOnly ? 'audio/mpeg' : 'video/mp4';
    player.appendChild(source);
    player.load();
  }

  player.ontimeupdate = () => {
    if (audioOnly) syncSlidesToMediaTime(player);
  };
  player.onloadedmetadata = () => {
    classroomSlideState.currentIndex = 0;
    renderSlideStage();
  };

  renderSlideStage();
}

function classroomPrevSlide() {
  if (classroomSlideState.currentIndex > 0) {
    classroomSlideState.currentIndex--;
    renderActiveSlide();
    renderSlideStage();
  }
}

function classroomNextSlide() {
  if (classroomSlideState.currentIndex < classroomSlideState.slides.length - 1) {
    classroomSlideState.currentIndex++;
    renderActiveSlide();
    renderSlideStage();
  }
}

function renderActiveSlide() {
  const titleEl = document.getElementById('slide-title');
  const bulletsEl = document.getElementById('slide-bullets');
  const counterEl = document.getElementById('slide-counter');

  if (classroomSlideState.slides.length === 0) {
    titleEl.textContent = 'Keine Folien';
    bulletsEl.innerHTML = '<li>Für diese Lektion wurden keine Präsentations-Folien generiert.</li>';
    counterEl.textContent = 'Folie 0 von 0';
    return;
  }

  const slide = classroomSlideState.slides[classroomSlideState.currentIndex];
  titleEl.textContent = slide.title;
  bulletsEl.innerHTML = '';
  
  (slide.bullets || []).forEach(b => {
    const li = document.createElement('li');
    li.textContent = b;
    bulletsEl.appendChild(li);
  });

  counterEl.textContent = `Folie ${classroomSlideState.currentIndex + 1} von ${classroomSlideState.slides.length}`;
  renderSlideStage();
}

// Slides initialized via classroomSlideState in selectLesson function

// Global exports for wizard onClick elements
window.openWizard = openWizard;
window.closeWizard = closeWizard;
window.wizardPrevStep = wizardPrevStep;
window.wizardNextStep = wizardNextStep;
window.wizardRegenerateCurriculum = wizardRegenerateCurriculum;
window.wizardGenerateLessonsContent = wizardGenerateLessonsContent;
window.wizardSelectLessonForEdit = wizardSelectLessonForEdit;
window.wizardSaveLessonEdits = wizardSaveLessonEdits;
window.wizardTriggerMediaRendering = wizardTriggerMediaRendering;
window.classroomPrevSlide = classroomPrevSlide;
window.classroomNextSlide = classroomNextSlide;

// Global exports for inline onclick handlers
window.handleDeleteCourse = handleDeleteCourse;
window.handleApproveCourse = handleApproveCourse;
window.handleStopCourse = handleStopCourse;


