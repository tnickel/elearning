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

  // Admin: Test MiniMax Key button
  document.getElementById('btn-test-minimax').addEventListener('click', handleTestMiniMax);

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

  // Admin: PPTX Drag and Drop Import
  const dropzone = document.getElementById('pptx-dropzone');
  const fileInput = document.getElementById('pptx-file-input');

  if (dropzone && fileInput) {
    dropzone.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        handlePptxUpload(e.target.files[0]);
      }
    });

    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.style.borderColor = 'var(--accent-primary)';
      dropzone.style.background = 'rgba(139, 92, 246, 0.08)';
    });

    dropzone.addEventListener('dragleave', () => {
      dropzone.style.borderColor = 'rgba(139, 92, 246, 0.3)';
      dropzone.style.background = 'rgba(139, 92, 246, 0.02)';
    });

    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.style.borderColor = 'rgba(139, 92, 246, 0.3)';
      dropzone.style.background = 'rgba(139, 92, 246, 0.02)';
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        handlePptxUpload(e.dataTransfer.files[0]);
      }
    });
  }
}

async function handlePptxUpload(file) {
  if (!file.name.endsWith('.pptx')) {
    alert('Bitte lade eine PowerPoint-Datei mit der Endung .pptx hoch.');
    return;
  }

  const dropzoneText = document.getElementById('pptx-dropzone-text');
  const originalText = dropzoneText.textContent;
  dropzoneText.textContent = `Importiere "${file.name}" (1:1-Export, kann 1–3 Min dauern)…`;
  
  try {
    const response = await fetch(`/api/courses/import-pptx?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${state.token}`
      },
      body: file
    });

    if (!response.ok) {
      const errText = await response.text();
      let message = 'Import fehlgeschlagen';
      try {
        const errJson = JSON.parse(errText);
        message = errJson.error || message;
      } catch (pe) {
        message = errText || message;
      }
      throw new Error(message);
    }

    const result = await response.json();
    alert(`Erfolgreich! Der Kurs "${result.topic}" wurde mit ${result.slideCount || '?'} Folien 1:1 importiert.\n\nÖffne den Folien-Wizard, um Sprechtexte und Vertonung zu bearbeiten.`);
    if (result.courseId) {
      openPptxStudio(result.courseId);
    } else {
      loadAdminDashboard();
    }
    
    // Reload course tables
    loadAdminDashboard();
  } catch (err) {
    console.error('Pptx upload error:', err);
    alert(`Fehler beim PowerPoint-Import: ${err.message}`);
  } finally {
    dropzoneText.textContent = originalText;
    document.getElementById('pptx-file-input').value = ''; // Reset file input
  }
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
    const pptxStudio = document.getElementById('pptx-studio-modal');
    if (modalAfterFetch && !modalAfterFetch.classList.contains('hidden')) {
      return;
    }
    if (pptxStudio && !pptxStudio.classList.contains('hidden')) {
      return;
    }
    
    tableBody.innerHTML = '';
    const sessionSelector = document.getElementById('verify-session-select');
    
    // Clear and reset session selector except first
    sessionSelector.innerHTML = '<option value="">Wähle eine Session zum Verifizieren...</option>';

    if (courses.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="5">Keine Kurse vorhanden. Erstelle oben deinen ersten Kurs!</td></tr>';
    } else {
      courses.forEach(course => {
        const row = document.createElement('tr');
        const isPptx = course.isPptx || course.progress?.source === 'pptx';
        const pipe = course.pipeline || {};

        const checkItem = (ok, label) => `
          <span class="pipeline-check ${ok ? 'ok' : 'missing'}" title="${label}">
            <i data-lucide="${ok ? 'check-circle-2' : 'circle'}"></i>
            <span>${label}</span>
          </span>`;

        const pipelineCell = isPptx
          ? `<div class="pipeline-checks">
              ${checkItem(!!pipe.slidesReady, 'Folien')}
              ${checkItem(!!pipe.narrationsReady, 'Sprechtext')}
              ${checkItem(!!pipe.audioReady, 'Vertonung')}
            </div>`
          : '<span style="color:var(--text-secondary);font-size:0.8rem;">—</span>';
        
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

        const openBtn = isPptx
          ? `<button class="btn btn-primary btn-sm" onclick="openPptxStudio('${course.id}')"><i data-lucide="presentation"></i> Folien-Wizard</button>`
          : `<button class="btn btn-secondary btn-sm" onclick="openWizard('${course.id}', '${course.topic.replace(/'/g, "\\'")}', '${course.duration || ''}')"><i data-lucide="edit-3"></i> Wizard</button>`;

        let actionBtn = '';
        if (course.status === 'curriculum_draft' || course.status === 'content_draft') {
          actionBtn = `
            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
              ${openBtn}
              <button class="btn btn-sm" style="background:#dc262620; color:#ef4444; border:1px solid #dc262640;" onclick="handleDeleteCourse('${course.id}')"><i data-lucide="trash-2"></i> Löschen</button>
            </div>
          `;
        } else if (course.status === 'pending_approval') {
          actionBtn = `
            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
              ${openBtn}
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
            <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
              ${course.status === 'active' ? '<span class="badge student">Freigegeben</span>' : ''}
              ${openBtn}
              <button class="btn btn-sm" style="background:#dc262620; color:#ef4444; border:1px solid #dc262640;" onclick="handleDeleteCourse('${course.id}')"><i data-lucide="trash-2"></i> Löschen</button>
            </div>
          `;
        }

        row.innerHTML = `
          <td><strong>${course.topic}</strong></td>
          <td>${pipelineCell}</td>
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
      document.getElementById('cfg-tts-provider').value = config.TTS_PROVIDER || 'elevenlabs';
      document.getElementById('cfg-llm-provider').value = config.LLM_PROVIDER || 'openrouter';
      document.getElementById('cfg-openrouter-model').value = config.OPENROUTER_MODEL || 'google/gemini-2.5-pro';
      document.getElementById('cfg-openrouter-key').value = config.OPENROUTER_API_KEY || '';
      document.getElementById('cfg-embedding-provider').value = config.EMBEDDING_PROVIDER || 'local';
      document.getElementById('cfg-vllm-url').value = config.vLLM_BASE_URL || 'http://localhost:8000/v1';
      document.getElementById('cfg-vllm-model').value = config.vLLM_MODEL || 'meta-llama/Meta-Llama-3-8B-Instruct';
      document.getElementById('cfg-elevenlabs-key').value = config.ELEVENLABS_API_KEY || '';
      document.getElementById('cfg-elevenlabs-voice').value = config.ELEVENLABS_VOICE_ID || '';
      document.getElementById('cfg-minimax-key').value = config.MINIMAX_API_KEY || '';
      document.getElementById('cfg-minimax-group').value = config.MINIMAX_GROUP_ID || '';
      document.getElementById('cfg-minimax-voice').value = config.MINIMAX_VOICE_ID || 'male-qn-qingse';
      document.getElementById('cfg-minimax-model').value = config.MINIMAX_MODEL || 'speech-02-hd';
      document.getElementById('cfg-heygen-url').value = config.HEYGEN_API_URL || 'https://api.heygen.com';
      document.getElementById('cfg-heygen-key').value = config.HEYGEN_API_KEY || '';

      // Set initial styles for the active TTS card
      setTimeout(() => {
        onTtsProviderChange();
      }, 0);
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

async function handleGenerateNarrations(courseId) {
  // Legacy entry – redirect into Folien-Wizard
  openPptxStudio(courseId);
}

/* ==================== PPTX FOLIEN STUDIO ==================== */
const pptxStudio = {
  courseId: null,
  slides: [],
  index: 0,
  pipeline: null,
  topic: '',
  dirty: false,
  busy: false,
};

async function openPptxStudio(courseId) {
  pptxStudio.courseId = courseId;
  pptxStudio.index = 0;
  pptxStudio.dirty = false;
  const modal = document.getElementById('pptx-studio-modal');
  modal.classList.remove('hidden');
  document.getElementById('pptx-studio-batch-status').textContent = 'Lade Folien…';
  await pptxReloadStudio();
  lucide.createIcons();
}

function closePptxStudio() {
  if (pptxStudio.dirty && !confirm('Ungespeicherte Änderungen verwerfen?')) return;
  document.getElementById('pptx-studio-modal').classList.add('hidden');
  pptxStudio.courseId = null;
  pptxStudio.slides = [];
  loadAdminDashboard();
}

async function pptxReloadStudio() {
  if (!pptxStudio.courseId) return;
  try {
    const data = await apiCall(`/courses/${pptxStudio.courseId}/pptx-studio`);
    pptxStudio.slides = data.slides || [];
    pptxStudio.pipeline = data.pipeline;
    pptxStudio.topic = data.course?.topic || '';
    document.getElementById('pptx-studio-title').innerHTML =
      `<i data-lucide="presentation"></i> ${pptxStudio.topic}`;
    pptxRenderPipeline(data.pipeline);
    pptxRenderThumbs();
    if (pptxStudio.index >= pptxStudio.slides.length) {
      pptxStudio.index = Math.max(0, pptxStudio.slides.length - 1);
    }
    pptxShowSlide(pptxStudio.index);
    document.getElementById('pptx-studio-batch-status').textContent =
      `${pptxStudio.slides.length} Folien · ${data.pipeline?.narrationsDone || 0} Texte · ${data.pipeline?.audioDone || 0} Vertonungen`;
    lucide.createIcons();
  } catch (err) {
    document.getElementById('pptx-studio-batch-status').textContent = 'Fehler: ' + err.message;
  }
}

function pptxRenderPipeline(pipe) {
  const el = document.getElementById('pptx-studio-pipeline');
  if (!el || !pipe) {
    if (el) el.innerHTML = '';
    return;
  }
  const item = (ok, label) =>
    `<span class="pipeline-check ${ok ? 'ok' : 'missing'}"><i data-lucide="${ok ? 'check-circle-2' : 'circle'}"></i><span>${label}</span></span>`;
  el.innerHTML = [
    item(!!pipe.slidesReady, 'Folien'),
    item(!!pipe.narrationsReady, 'Sprechtext'),
    item(!!pipe.audioReady, 'Vertonung'),
  ].join('');
}

function pptxRenderThumbs() {
  const rail = document.getElementById('pptx-thumb-rail');
  rail.innerHTML = pptxStudio.slides.map((s, i) => `
    <button type="button" class="pptx-thumb ${i === pptxStudio.index ? 'active' : ''}" onclick="pptxSelectSlide(${i})" title="${(s.title || '').replace(/"/g, '&quot;')}">
      <span class="pptx-thumb-num">${i + 1}</span>
      <img src="${s.image_url}" alt="Folie ${i + 1}" loading="lazy" />
      <div class="pptx-thumb-badges">
        <span class="${s.hasNotes ? 'ok' : 'miss'}" title="Sprechtext"><i data-lucide="${s.hasNotes ? 'check' : 'type'}"></i></span>
        <span class="${s.hasAudio ? 'ok' : 'miss'}" title="Vertonung"><i data-lucide="${s.hasAudio ? 'check' : 'volume-2'}"></i></span>
      </div>
    </button>
  `).join('');
}

function pptxShowSlide(idx) {
  if (!pptxStudio.slides.length) {
    document.getElementById('pptx-stage-img').classList.add('hidden');
    document.getElementById('pptx-stage-empty').classList.remove('hidden');
    return;
  }
  pptxStudio.index = idx;
  pptxStudio.dirty = false;
  const s = pptxStudio.slides[idx];
  const img = document.getElementById('pptx-stage-img');
  img.classList.remove('hidden');
  document.getElementById('pptx-stage-empty').classList.add('hidden');
  img.src = s.image_url;
  document.getElementById('pptx-slide-title').value = s.title || '';
  document.getElementById('pptx-slide-notes').value = s.speaker_notes || '';
  document.getElementById('pptx-slide-counter').textContent = `Folie ${idx + 1} / ${pptxStudio.slides.length}`;

  const audioBox = document.getElementById('pptx-audio-box');
  const player = document.getElementById('pptx-audio-player');
  if (s.audio_url) {
    audioBox.classList.remove('hidden');
    player.src = s.audio_url;
  } else {
    audioBox.classList.add('hidden');
    player.removeAttribute('src');
  }

  document.getElementById('pptx-editor-hint').textContent = s.hasNotes
    ? (s.hasAudio ? 'Sprechtext und Vertonung vorhanden.' : 'Sprechtext vorhanden – noch nicht vertont.')
    : 'Noch kein Sprechtext – generieren oder manuell eingeben.';

  pptxRenderThumbs();
  lucide.createIcons();
}

function pptxSelectSlide(idx) {
  if (pptxStudio.dirty && !confirm('Ungespeicherte Änderungen verwerfen?')) return;
  pptxShowSlide(idx);
}

function pptxPrevSlide() {
  if (pptxStudio.index > 0) pptxSelectSlide(pptxStudio.index - 1);
}

function pptxNextSlide() {
  if (pptxStudio.index < pptxStudio.slides.length - 1) pptxSelectSlide(pptxStudio.index + 1);
}

function pptxMarkDirty() {
  pptxStudio.dirty = true;
}

async function pptxSaveSlide() {
  const s = pptxStudio.slides[pptxStudio.index];
  if (!s) return;
  const speaker_notes = document.getElementById('pptx-slide-notes').value;
  const title = document.getElementById('pptx-slide-title').value;
  try {
    document.getElementById('pptx-editor-hint').textContent = 'Speichere…';
    const res = await apiCall(`/courses/${pptxStudio.courseId}/slides/${s.lessonId}/${s.slideIndex}`, {
      method: 'PUT',
      body: JSON.stringify({ speaker_notes, title }),
    });
    s.speaker_notes = speaker_notes;
    s.title = title;
    s.hasNotes = !!(speaker_notes && speaker_notes.trim());
    pptxStudio.pipeline = res.pipeline || pptxStudio.pipeline;
    pptxStudio.dirty = false;
    pptxRenderPipeline(pptxStudio.pipeline);
    pptxRenderThumbs();
    document.getElementById('pptx-editor-hint').textContent = 'Gespeichert.';
    lucide.createIcons();
  } catch (err) {
    document.getElementById('pptx-editor-hint').textContent = 'Fehler: ' + err.message;
  }
}

async function pptxNarrateCurrent() {
  const s = pptxStudio.slides[pptxStudio.index];
  if (!s || pptxStudio.busy) return;
  pptxStudio.busy = true;
  const btn = document.getElementById('pptx-btn-narrate');
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="refresh-cw" class="spin"></i> Generiere…';
  lucide.createIcons();
  try {
    // Save manual edits first if any
    if (pptxStudio.dirty) await pptxSaveSlide();
    const res = await apiCall(`/courses/${pptxStudio.courseId}/slides/${s.lessonId}/${s.slideIndex}/narrate`, {
      method: 'POST',
    });
    s.speaker_notes = res.speaker_notes || '';
    s.hasNotes = !!(s.speaker_notes && s.speaker_notes.trim());
    document.getElementById('pptx-slide-notes').value = s.speaker_notes;
    pptxStudio.pipeline = res.pipeline || pptxStudio.pipeline;
    pptxRenderPipeline(pptxStudio.pipeline);
    pptxRenderThumbs();
    document.getElementById('pptx-editor-hint').textContent = 'Sprechtext generiert.';
  } catch (err) {
    document.getElementById('pptx-editor-hint').textContent = 'Fehler: ' + err.message;
    alert('Textgenerierung fehlgeschlagen: ' + err.message);
  } finally {
    pptxStudio.busy = false;
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="sparkles"></i> Text generieren';
    lucide.createIcons();
  }
}

async function pptxTtsCurrent() {
  const s = pptxStudio.slides[pptxStudio.index];
  if (!s || pptxStudio.busy) return;
  const notes = document.getElementById('pptx-slide-notes').value.trim();
  if (!notes) {
    alert('Bitte zuerst einen Sprechtext eingeben oder generieren.');
    return;
  }
  pptxStudio.busy = true;
  const btn = document.getElementById('pptx-btn-tts');
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="refresh-cw" class="spin"></i> Vertone…';
  lucide.createIcons();
  try {
    if (pptxStudio.dirty || notes !== (s.speaker_notes || '').trim()) {
      await pptxSaveSlide();
    }
    const res = await apiCall(`/courses/${pptxStudio.courseId}/slides/${s.lessonId}/${s.slideIndex}/tts`, {
      method: 'POST',
    });
    s.audio_url = res.audio_url;
    s.hasAudio = true;
    pptxStudio.pipeline = res.pipeline || pptxStudio.pipeline;
    pptxRenderPipeline(pptxStudio.pipeline);
    pptxShowSlide(pptxStudio.index);
    document.getElementById('pptx-editor-hint').textContent = 'Vertonung fertig.';
  } catch (err) {
    document.getElementById('pptx-editor-hint').textContent = 'Fehler: ' + err.message;
    alert('Vertonung fehlgeschlagen: ' + err.message);
  } finally {
    pptxStudio.busy = false;
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="volume-2"></i> Vertonen';
    lucide.createIcons();
  }
}

async function pptxGenerateAllNotes() {
  if (!pptxStudio.courseId) return;
  if (!confirm('Sprechtexte für alle fehlenden Folien per KI generieren? Das kann einige Minuten dauern.')) return;
  const status = document.getElementById('pptx-studio-batch-status');
  try {
    status.textContent = 'Starte Batch-Sprechtexte…';
    const res = await apiCall(`/courses/${pptxStudio.courseId}/generate-narrations`, {
      method: 'POST',
      body: JSON.stringify({ onlyMissing: true }),
    });
    status.textContent = `Generiere ${res.total || '?'} Texte… (Fortschritt in der Liste)`;
    pptxPollUntilIdle();
  } catch (err) {
    status.textContent = 'Fehler: ' + err.message;
    alert(err.message);
  }
}

async function pptxGenerateAllTts() {
  if (!pptxStudio.courseId) return;
  if (!confirm('Alle Folien mit Sprechtext vertonen?')) return;
  const status = document.getElementById('pptx-studio-batch-status');
  try {
    status.textContent = 'Starte Batch-Vertonung…';
    const res = await apiCall(`/courses/${pptxStudio.courseId}/generate-tts`, {
      method: 'POST',
      body: JSON.stringify({ onlyMissing: true }),
    });
    status.textContent = `Vertone ${res.total || '?'} Folien…`;
    pptxPollUntilIdle();
  } catch (err) {
    status.textContent = 'Fehler: ' + err.message;
    alert(err.message);
  }
}

function pptxPollUntilIdle() {
  const id = pptxStudio.courseId;
  let tries = 0;
  const timer = setInterval(async () => {
    tries++;
    try {
      const data = await apiCall(`/courses/${id}/pptx-studio`);
      const status = data.course?.status;
      document.getElementById('pptx-studio-batch-status').textContent =
        data.course?.progress?.step || 'Arbeite…';
      if (status !== 'generating' || tries > 120) {
        clearInterval(timer);
        if (pptxStudio.courseId === id) {
          await pptxReloadStudio();
        }
      }
    } catch {
      if (tries > 5) clearInterval(timer);
    }
  }, 2500);
}

async function pptxApproveIfReady() {
  if (!pptxStudio.courseId) return;
  const pipe = pptxStudio.pipeline || {};
  if (!pipe.narrationsReady) {
    if (!confirm('Nicht alle Sprechtexte sind fertig. Trotzdem freigeben?')) return;
  } else if (!pipe.audioReady) {
    if (!confirm('Nicht alle Folien sind vertont. Trotzdem freigeben?')) return;
  }
  try {
    await apiCall(`/courses/${pptxStudio.courseId}/approve`, { method: 'POST' });
    alert('Kurs freigegeben!');
    closePptxStudio();
  } catch (err) {
    alert('Freigabe fehlgeschlagen: ' + err.message);
  }
}

// Mark dirty on edit
document.addEventListener('DOMContentLoaded', () => {
  const notes = document.getElementById('pptx-slide-notes');
  const title = document.getElementById('pptx-slide-title');
  if (notes) notes.addEventListener('input', pptxMarkDirty);
  if (title) title.addEventListener('input', pptxMarkDirty);
});

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
    TTS_PROVIDER: document.getElementById('cfg-tts-provider').value,
    LLM_PROVIDER: document.getElementById('cfg-llm-provider').value,
    OPENROUTER_MODEL: document.getElementById('cfg-openrouter-model').value,
    OPENROUTER_API_KEY: document.getElementById('cfg-openrouter-key').value,
    EMBEDDING_PROVIDER: document.getElementById('cfg-embedding-provider').value,
    vLLM_BASE_URL: document.getElementById('cfg-vllm-url').value,
    vLLM_MODEL: document.getElementById('cfg-vllm-model').value,
    ELEVENLABS_API_KEY: document.getElementById('cfg-elevenlabs-key').value,
    ELEVENLABS_VOICE_ID: document.getElementById('cfg-elevenlabs-voice').value,
    MINIMAX_API_KEY: document.getElementById('cfg-minimax-key').value,
    MINIMAX_GROUP_ID: document.getElementById('cfg-minimax-group').value,
    MINIMAX_VOICE_ID: document.getElementById('cfg-minimax-voice').value,
    MINIMAX_MODEL: document.getElementById('cfg-minimax-model').value,
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

async function handleTestMiniMax() {
  const apiKey = document.getElementById('cfg-minimax-key').value;
  const groupId = document.getElementById('cfg-minimax-group').value;
  const voiceId = document.getElementById('cfg-minimax-voice').value;
  const statusDiv = document.getElementById('minimax-test-status');
  const btn = document.getElementById('btn-test-minimax');

  if (!apiKey || !groupId) {
    statusDiv.style.color = '#ff6b6b';
    statusDiv.textContent = 'Bitte Key und Group ID eintragen!';
    statusDiv.style.display = 'block';
    return;
  }

  statusDiv.style.color = '#aaa';
  statusDiv.textContent = 'Verbindung zu MiniMax wird getestet...';
  statusDiv.style.display = 'block';
  btn.disabled = true;

  try {
    const res = await apiCall('/admin/config/test-minimax', {
      method: 'POST',
      body: JSON.stringify({ apiKey, groupId, voiceId }),
    });

    if (res.success) {
      statusDiv.style.color = '#51cf66';
      statusDiv.innerHTML = `<i class="inline-icon" data-lucide="check-circle" style="width:12px;height:12px;display:inline-block;vertical-align:middle;margin-right:4px;"></i> Verbindung erfolgreich! Guthaben: <strong>${res.balance}</strong>`;
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

function onTtsProviderChange() {
  const provider = document.getElementById('cfg-tts-provider').value;
  const cardEl = document.getElementById('card-elevenlabs');
  const cardMm = document.getElementById('card-minimax');
  const badge = document.getElementById('tts-active-badge');
  const dotEl = document.getElementById('el-active-dot');
  const dotMm = document.getElementById('mm-active-dot');

  if (!cardEl || !cardMm) return;

  if (provider === 'elevenlabs') {
    cardEl.style.borderColor = 'rgba(167,139,250,0.5)';
    cardEl.style.boxShadow = '0 0 10px rgba(167,139,250,0.15)';
    cardMm.style.borderColor = 'rgba(255,255,255,0.06)';
    cardMm.style.boxShadow = 'none';
    if (badge) badge.textContent = 'AKTIV: ElevenLabs';
    if (dotEl) {
      dotEl.style.background = '#51cf66';
      dotEl.style.boxShadow = '0 0 6px #51cf66';
    }
    if (dotMm) {
      dotMm.style.background = 'rgba(255,255,255,0.15)';
      dotMm.style.boxShadow = 'none';
    }
  } else {
    cardMm.style.borderColor = 'rgba(251,146,60,0.5)';
    cardMm.style.boxShadow = '0 0 10px rgba(251,146,60,0.15)';
    cardEl.style.borderColor = 'rgba(255,255,255,0.06)';
    cardEl.style.boxShadow = 'none';
    if (badge) badge.textContent = 'AKTIV: MiniMax';
    if (dotMm) {
      dotMm.style.background = '#51cf66';
      dotMm.style.boxShadow = '0 0 6px #51cf66';
    }
    if (dotEl) {
      dotEl.style.background = 'rgba(255,255,255,0.15)';
      dotEl.style.boxShadow = 'none';
    }
  }
}
window.onTtsProviderChange = onTtsProviderChange;

async function loadUsageStats() {
  const orEl = document.getElementById('stat-openrouter-usage');
  const elEl = document.getElementById('stat-elevenlabs-usage');
  const mmEl = document.getElementById('stat-minimax-usage');
  if (!orEl || !elEl) return;

  try {
    const data = await apiCall('/admin/usage');
    orEl.textContent = data.openrouter.usage;
    if (data.openrouter.label) {
      orEl.innerHTML = `${data.openrouter.usage} <span style="font-size: 0.75rem; font-weight: normal; color: var(--text-secondary);">(${data.openrouter.label})</span>`;
    }
    elEl.textContent = data.elevenlabs.usage;
    if (mmEl) {
      mmEl.textContent = data.minimax ? data.minimax.usage : 'Nicht geladen';
    }
  } catch (err) {
    console.error('Failed to load usage stats:', err);
    orEl.textContent = 'Fehler beim Laden';
    elEl.textContent = 'Fehler beim Laden';
    if (mmEl) mmEl.textContent = 'Fehler beim Laden';
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

        // Fetch original slide to preserve other properties (layout, image_url, etc.)
        const originalLesson = wizardState.curriculumData.lessons.find(l => l.id === lesId);
        const originalSlide = originalLesson?.contentPayload?.slides?.[idx] || {};

        slides[idx] = {
          ...originalSlide,
          title: slideTitle,
          bullets
        };
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
    <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 8px; margin-bottom: 12px;">
      <h4 style="font-size: 0.95rem; color: #fff; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 65%;" title="${lesson.title}">"${lesson.title}" bearbeiten</h4>
      <button class="btn btn-secondary btn-sm" onclick="openSlidePreview('${lessonId}')" style="width: auto; margin: 0; background: rgba(139, 92, 246, 0.15); border-color: rgba(139, 92, 246, 0.4); color: var(--accent-primary); font-weight: 600; display: inline-flex; align-items: center; gap: 6px;">
        <i data-lucide="presentation"></i> Folien-Vorschau
      </button>
    </div>

    
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

    <div style="display: flex; gap: 8px; margin-top: 8px;">
      <button class="btn btn-primary btn-sm" onclick="wizardSaveLessonEdits('${lessonId}')" style="flex: 1; width: auto; margin: 0;">
        Speichern <i data-lucide="save"></i>
      </button>
      <button class="btn btn-secondary btn-sm" onclick="openSlidePreview('${lessonId}')" style="flex: 1; width: auto; margin: 0; background: rgba(139, 92, 246, 0.1); border-color: rgba(139, 92, 246, 0.3); color: var(--accent-primary);">
        Folien-Vorschau <i data-lucide="presentation"></i>
      </button>
    </div>
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
  currentIndex: 0,
  perSlideAudio: false,
};

function isAudioOnlyUrl(url) {
  if (!url) return true;
  return /\.mp3($|\?)/i.test(url) || url.startsWith('/audio/');
}

function renderSlideStage() {
  const container = document.getElementById('slide-stage-container');
  const counterEl = document.getElementById('slide-stage-counter');
  if (!container || !counterEl) return;

  const slides = classroomSlideState.slides || [];
  if (slides.length === 0) {
    const titleEl = document.getElementById('slide-stage-title');
    const bulletsEl = document.getElementById('slide-stage-bullets');
    if (titleEl) titleEl.textContent = state.activeLesson?.title || 'Lektion';
    if (bulletsEl) bulletsEl.innerHTML = '<li>Keine Folien für diese Lektion vorhanden.</li>';
    const imgWrapper = document.getElementById('slide-stage-img-wrapper');
    if (imgWrapper) imgWrapper.style.display = 'none';
    counterEl.textContent = 'Keine Folien';
    return;
  }

  const idx = Math.min(classroomSlideState.currentIndex, slides.length - 1);
  const slide = slides[idx];
  const layout = slide.layout || 'bullets';

  // Hide all layout blocks first
  const bulletsLayout = document.getElementById('slide-layout-bullets');
  const mermaidLayout = document.getElementById('slide-layout-mermaid');
  const codeLayout = document.getElementById('slide-layout-code');
  const imageLayout = document.getElementById('slide-layout-image');
  const stageEl = document.getElementById('slide-stage');

  if (bulletsLayout) bulletsLayout.classList.add('hidden');
  if (mermaidLayout) mermaidLayout.classList.add('hidden');
  if (codeLayout) codeLayout.classList.add('hidden');
  if (imageLayout) imageLayout.classList.add('hidden');
  if (stageEl) stageEl.classList.toggle('pptx-image-mode', layout === 'image');

  if (layout === 'image' && (slide.image_url || slide.imageUrl)) {
    if (imageLayout) {
      imageLayout.classList.remove('hidden');
      const fullImg = document.getElementById('slide-stage-full-image');
      if (fullImg) {
        fullImg.src = slide.image_url || slide.imageUrl;
        fullImg.alt = slide.title || `Folie ${idx + 1}`;
      }
    }
  } else if (layout === 'mermaid' && slide.mermaid_code) {
    // ── MERMAID LAYOUT ───────────────────────────────────────────────────
    if (mermaidLayout) {
      mermaidLayout.classList.remove('hidden');
      document.getElementById('slide-stage-mermaid-title').textContent = slide.title || 'Diagramm';
      
      const chartContainer = document.getElementById('slide-stage-mermaid-container');
      chartContainer.innerHTML = `<pre class="mermaid" id="mermaid-svg-${idx}">${slide.mermaid_code}</pre>`;
      
      // Initialize/Render Mermaid
      setTimeout(() => {
        try {
          if (typeof mermaid !== 'undefined') {
            mermaid.run({
              nodes: [document.getElementById(`mermaid-svg-${idx}`)]
            });
          }
        } catch (err) {
          console.error('Mermaid render error:', err);
          chartContainer.innerHTML = `<div style="color:var(--accent-error); font-size:0.85rem;">[Diagramm-Fehler: Syntax ungültig]</div><pre style="text-align:left; font-size:0.75rem; color:var(--text-secondary); margin-top:8px; white-space:pre-wrap; word-break:break-all;">${slide.mermaid_code}</pre>`;
        }
      }, 50);
    }

  } else if (layout === 'code' && slide.code_snippet) {
    // ── CODE LAYOUT ──────────────────────────────────────────────────────
    if (codeLayout) {
      codeLayout.classList.remove('hidden');
      document.getElementById('slide-stage-code-title').textContent = slide.title || 'Code-Beispiel';
      document.getElementById('slide-stage-code-filename').textContent = slide.code_language || 'code';
      document.getElementById('slide-stage-code-block').innerHTML = highlightCode(slide.code_snippet, slide.code_language);
      
      const bulletsEl = document.getElementById('slide-stage-code-bullets');
      bulletsEl.innerHTML = '';
      (slide.bullets || []).forEach(b => {
        const li = document.createElement('li');
        li.textContent = b;
        bulletsEl.appendChild(li);
      });
    }

  } else {
    // ── BULLETS LAYOUT (Default) ──────────────────────────────────────────
    if (bulletsLayout) {
      bulletsLayout.classList.remove('hidden');
      document.getElementById('slide-stage-title').textContent = slide.title || `Folie ${idx + 1}`;
      
      const bulletsEl = document.getElementById('slide-stage-bullets');
      bulletsEl.innerHTML = '';
      (slide.bullets || []).forEach((b) => {
        const li = document.createElement('li');
        li.textContent = b;
        bulletsEl.appendChild(li);
      });

      const imgWrapper = document.getElementById('slide-stage-img-wrapper');
      const imgEl = document.getElementById('slide-stage-image');
      const courseTopic = state.activeCourse ? state.activeCourse.topic : '';
      const imageUrl = getSlideImageUrl(slide, courseTopic);
      if (imageUrl) {
        imgEl.src = imageUrl;
        imgWrapper.style.display = 'block';
      } else {
        imgWrapper.style.display = 'none';
      }
    }
  }

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

  const slides = (lesson.contentPayload && lesson.contentPayload.slides) || [];
  const hasPerSlideAudio = slides.some((s) => s.audio_url && String(s.audio_url).trim());
  classroomSlideState.perSlideAudio = hasPerSlideAudio;

  const url = hasPerSlideAudio
    ? (slides.find((s) => s.audio_url)?.audio_url || lesson.videoUrl || '')
    : (lesson.videoUrl || '');
  const audioOnly = isAudioOnlyUrl(url) || hasPerSlideAudio;
  container.classList.toggle('audio-mode', audioOnly);
  container.classList.toggle('video-mode', !audioOnly && !!url);

  if (mediaLabel) {
    mediaLabel.textContent = hasPerSlideAudio
      ? 'Folien-Vertonung'
      : (audioOnly ? 'ElevenLabs Audio + Folien' : 'Avatar-Video');
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
    if (audioOnly && !classroomSlideState.perSlideAudio) syncSlidesToMediaTime(player);
  };
  player.onended = () => {
    if (classroomSlideState.perSlideAudio) {
      classroomNextSlide();
    }
  };
  player.onloadedmetadata = () => {
    if (!classroomSlideState.perSlideAudio) {
      classroomSlideState.currentIndex = 0;
    }
    renderSlideStage();
  };

  renderSlideStage();
}

function playCurrentSlideAudio() {
  const player = document.getElementById('avatar-video-player');
  if (!player || !classroomSlideState.perSlideAudio) return;
  const slide = classroomSlideState.slides[classroomSlideState.currentIndex];
  if (!slide?.audio_url) return;
  const url = slide.audio_url;
  const cur = player.currentSrc || '';
  if (!cur.includes(url.split('?')[0])) {
    while (player.firstChild) player.removeChild(player.firstChild);
    const source = document.createElement('source');
    source.src = `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;
    source.type = 'audio/mpeg';
    player.appendChild(source);
    player.load();
  }
  player.play().catch(() => {});
}

function classroomPrevSlide() {
  if (classroomSlideState.currentIndex > 0) {
    classroomSlideState.currentIndex--;
    renderActiveSlide();
    renderSlideStage();
    if (classroomSlideState.perSlideAudio) playCurrentSlideAudio();
  }
}

function classroomNextSlide() {
  if (classroomSlideState.currentIndex < classroomSlideState.slides.length - 1) {
    classroomSlideState.currentIndex++;
    renderActiveSlide();
    renderSlideStage();
    if (classroomSlideState.perSlideAudio) playCurrentSlideAudio();
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

// Slides initialized via classroomSlideState in selectLesson function

// Slide Previewer State & Functions
let previewSlideState = {
  slides: [],
  currentIndex: 0,
  speechScript: ''
};

function openSlidePreview(lessonId) {
  const slides = [];
  const titleInputs = document.querySelectorAll(`.wz-slide-title-input[data-lesson-id="${lessonId}"]`);
  
  titleInputs.forEach(titleIn => {
    const sIdx = parseInt(titleIn.dataset.slideIndex);
    const bulletsIn = document.querySelector(`.wz-slide-bullets-input[data-lesson-id="${lessonId}"][data-slide-index="${sIdx}"]`);
    
    const title = titleIn.value;
    const bullets = bulletsIn ? bulletsIn.value.split('\n').map(b => b.trim()).filter(b => b) : [];
    
    const originalLesson = wizardState.curriculumData.lessons.find(l => l.id === lessonId);
    const originalSlide = originalLesson?.contentPayload?.slides?.[sIdx] || {};

    slides[sIdx] = {
      title,
      bullets,
      layout: originalSlide.layout || 'bullets',
      mermaid_code: originalSlide.mermaid_code || '',
      code_snippet: originalSlide.code_snippet || '',
      code_language: originalSlide.code_language || 'javascript',
      image_url: originalSlide.image_url || '',
      speaker_notes: originalSlide.speaker_notes || '',
      hide_image: originalSlide.hide_image === true
    };
  });

  if (slides.length === 0) {
    const originalLesson = wizardState.curriculumData.lessons.find(l => l.id === lessonId);
    if (originalLesson && originalLesson.contentPayload && originalLesson.contentPayload.slides) {
      previewSlideState.slides = originalLesson.contentPayload.slides;
    } else {
      previewSlideState.slides = [];
    }
  } else {
    previewSlideState.slides = slides.filter(Boolean);
  }

  // Fetch the speech script from the active editor DOM
  const scriptText = document.getElementById('wz-les-script-edit')?.value || '';
  previewSlideState.speechScript = scriptText;

  previewSlideState.currentIndex = 0;
  
  const modal = document.getElementById('slide-preview-modal');
  if (modal) {
    modal.classList.remove('hidden');
    renderPreviewSlide();
  }
}

function closeSlidePreview() {
  const modal = document.getElementById('slide-preview-modal');
  if (modal) modal.classList.add('hidden');
}

function previewPrevSlide() {
  if (previewSlideState.currentIndex > 0) {
    previewSlideState.currentIndex--;
    renderPreviewSlide();
  }
}

function previewNextSlide() {
  if (previewSlideState.currentIndex < previewSlideState.slides.length - 1) {
    previewSlideState.currentIndex++;
    renderPreviewSlide();
  }
}

function renderPreviewSlide() {
  const container = document.getElementById('preview-slide-stage-container');
  const counterEl = document.getElementById('preview-slide-counter');
  if (!container || !counterEl) return;

  const slides = previewSlideState.slides || [];
  const idx = Math.min(previewSlideState.currentIndex, slides.length - 1);

  // Render current speech script in the sidebar card (prefer per-slide speaker_notes)
  const scriptTextEl = document.getElementById('preview-slide-script-text');
  if (scriptTextEl) {
    const totalSlides = slides.length || 1;
    const slide = slides[idx];
    const currentSlideScript =
      (slide && slide.speaker_notes && String(slide.speaker_notes).trim()) ||
      getSlideSpeechScript(previewSlideState.speechScript, idx, totalSlides);
    scriptTextEl.innerHTML = currentSlideScript
      ? currentSlideScript
          .split('\n\n')
          .map(p => `<p style="margin-bottom: 12px; line-height: 1.6; text-align: left;">${p}</p>`)
          .join('')
      : '<p style="color: var(--text-secondary); text-align: center; margin-top: 20px;">Kein Sprecherskript für diese Folie vorhanden.</p>';
  }


  if (slides.length === 0) {
    const titleEl = document.getElementById('preview-slide-stage-title');
    const bulletsEl = document.getElementById('preview-slide-stage-bullets');
    if (titleEl) titleEl.textContent = 'Keine Folien';
    if (bulletsEl) bulletsEl.innerHTML = '<li>Keine Folien vorhanden.</li>';
    const imgWrapper = document.getElementById('preview-slide-stage-img-wrapper');
    if (imgWrapper) imgWrapper.style.display = 'none';
    counterEl.textContent = 'Folie 0 von 0';
    return;
  }

  const slide = slides[idx];
  const layout = slide.layout || 'bullets';

  const bulletsLayout = document.getElementById('preview-slide-layout-bullets');
  const mermaidLayout = document.getElementById('preview-slide-layout-mermaid');
  const codeLayout = document.getElementById('preview-slide-layout-code');
  const imageLayout = document.getElementById('preview-slide-layout-image');
  const previewStage = document.getElementById('preview-slide-stage');

  if (bulletsLayout) bulletsLayout.classList.add('hidden');
  if (mermaidLayout) mermaidLayout.classList.add('hidden');
  if (codeLayout) codeLayout.classList.add('hidden');
  if (imageLayout) imageLayout.classList.add('hidden');
  if (previewStage) previewStage.classList.toggle('pptx-image-mode', layout === 'image');

  if (layout === 'image' && (slide.image_url || slide.imageUrl)) {
    if (imageLayout) {
      imageLayout.classList.remove('hidden');
      const fullImg = document.getElementById('preview-slide-stage-full-image');
      if (fullImg) {
        fullImg.src = slide.image_url || slide.imageUrl;
        fullImg.alt = slide.title || `Folie ${idx + 1}`;
      }
    }
  } else if (layout === 'mermaid' && slide.mermaid_code) {
    if (mermaidLayout) {
      mermaidLayout.classList.remove('hidden');
      document.getElementById('preview-slide-stage-mermaid-title').textContent = slide.title || 'Diagramm';
      
      const chartContainer = document.getElementById('preview-slide-stage-mermaid-container');
      chartContainer.innerHTML = `<pre class="mermaid" id="preview-mermaid-svg-${idx}">${slide.mermaid_code}</pre>`;
      
      setTimeout(() => {
        try {
          if (typeof mermaid !== 'undefined') {
            mermaid.run({
              nodes: [document.getElementById(`preview-mermaid-svg-${idx}`)]
            });
          }
        } catch (err) {
          console.error('Mermaid preview render error:', err);
          chartContainer.innerHTML = `<div style="color:var(--accent-error); font-size:0.85rem;">[Diagramm-Fehler: Syntax ungültig]</div><pre style="text-align:left; font-size:0.75rem; color:var(--text-secondary); margin-top:8px; white-space:pre-wrap; word-break:break-all;">${slide.mermaid_code}</pre>`;
        }
      }, 50);
    }

  } else if (layout === 'code' && slide.code_snippet) {
    if (codeLayout) {
      codeLayout.classList.remove('hidden');
      document.getElementById('preview-slide-stage-code-title').textContent = slide.title || 'Code-Beispiel';
      document.getElementById('preview-slide-stage-code-filename').textContent = slide.code_language || 'code';
      document.getElementById('preview-slide-stage-code-block').innerHTML = highlightCode(slide.code_snippet, slide.code_language);
      
      const bulletsEl = document.getElementById('preview-slide-stage-code-bullets');
      bulletsEl.innerHTML = '';
      (slide.bullets || []).forEach(b => {
        const li = document.createElement('li');
        li.textContent = b;
        bulletsEl.appendChild(li);
      });
    }

  } else {
    if (bulletsLayout) {
      bulletsLayout.classList.remove('hidden');
      document.getElementById('preview-slide-stage-title').textContent = slide.title || `Folie ${idx + 1}`;
      
      const bulletsEl = document.getElementById('preview-slide-stage-bullets');
      bulletsEl.innerHTML = '';
      (slide.bullets || []).forEach((b) => {
        const li = document.createElement('li');
        li.textContent = b;
        bulletsEl.appendChild(li);
      });

      const imgWrapper = document.getElementById('preview-slide-stage-img-wrapper');
      const imgEl = document.getElementById('preview-slide-stage-image');
      const courseTopic = wizardState.topic || '';
      const imageUrl = getSlideImageUrl(slide, courseTopic);
      if (imageUrl) {
        imgEl.src = imageUrl;
        imgWrapper.style.display = 'block';
      } else {
        imgWrapper.style.display = 'none';
      }
    }
  }

  counterEl.textContent = `Folie ${idx + 1} von ${slides.length}`;
  lucide.createIcons();
}

function highlightCode(code, lang) {
  if (!code) return '';
  let escaped = code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  if (lang === 'dockerfile') {
    const keywords = /\b(FROM|RUN|COPY|WORKDIR|EXPOSE|CMD|ENV|ENTRYPOINT|ADD|VOLUME|USER)\b/g;
    escaped = escaped.replace(keywords, '<span style="color: #f472b6; font-weight: bold;">$1</span>');
    escaped = escaped.replace(/(["'])(.*?)\1/g, '<span style="color: #34d399;">$1$2$1</span>');
    escaped = escaped.replace(/(^|\s)(#.*?)$/gm, '$1<span style="color: #6b7280; font-style: italic;">$2</span>');
  } else if (lang === 'yaml' || lang === 'yml') {
    escaped = escaped.replace(/^(\s*)([a-zA-Z0-9_-]+:)/gm, '$1<span style="color: #60a5fa; font-weight: 500;">$2</span>');
    escaped = escaped.replace(/(:\s+)(?!#)(.+)$/gm, '$1<span style="color: #34d399;">$2</span>');
    escaped = escaped.replace(/(^|\s)(#.*?)$/gm, '$1<span style="color: #6b7280; font-style: italic;">$2</span>');
  }
  return escaped;
}


// Global exports for wizard onClick elements
window.openWizard = openWizard;
window.closeWizard = closeWizard;
window.openPptxStudio = openPptxStudio;
window.closePptxStudio = closePptxStudio;
window.pptxPrevSlide = pptxPrevSlide;
window.pptxNextSlide = pptxNextSlide;
window.pptxSelectSlide = pptxSelectSlide;
window.pptxSaveSlide = pptxSaveSlide;
window.pptxNarrateCurrent = pptxNarrateCurrent;
window.pptxTtsCurrent = pptxTtsCurrent;
window.pptxGenerateAllNotes = pptxGenerateAllNotes;
window.pptxGenerateAllTts = pptxGenerateAllTts;
window.pptxApproveIfReady = pptxApproveIfReady;
window.wizardPrevStep = wizardPrevStep;
window.wizardNextStep = wizardNextStep;
window.wizardRegenerateCurriculum = wizardRegenerateCurriculum;
window.wizardGenerateLessonsContent = wizardGenerateLessonsContent;
window.wizardSelectLessonForEdit = wizardSelectLessonForEdit;
window.wizardSaveLessonEdits = wizardSaveLessonEdits;
window.wizardTriggerMediaRendering = wizardTriggerMediaRendering;
window.classroomPrevSlide = classroomPrevSlide;
window.classroomNextSlide = classroomNextSlide;
window.openSlidePreview = openSlidePreview;
window.closeSlidePreview = closeSlidePreview;
window.previewPrevSlide = previewPrevSlide;
window.previewNextSlide = previewNextSlide;

// Global exports for inline onclick handlers
window.handleDeleteCourse = handleDeleteCourse;
window.handleApproveCourse = handleApproveCourse;
window.handleGenerateNarrations = handleGenerateNarrations;
window.handleStopCourse = handleStopCourse;
window.toggleFullscreen = toggleFullscreen;

function getSlideImageUrl(slide, courseTopic) {
  // Course authors can intentionally keep a text slide image-free. This is
  // useful when the automatic topic fallback would distract from the message.
  if (slide.hide_image === true) {
    return '';
  }
  if (slide.image_url && slide.image_url.trim()) {
    return slide.image_url;
  }
  if (slide.layout === 'mermaid' || slide.layout === 'code') {
    return '';
  }
  const textToSearch = `${slide.title || ''} ${(slide.bullets || []).join(' ')} ${courseTopic || ''}`.toLowerCase();
  
  if (textToSearch.includes('docker') || textToSearch.includes('container') || textToSearch.includes('kubernetes') || textToSearch.includes('podman') || textToSearch.includes('devops')) {
    if (slide.title && slide.title.length % 2 === 0) {
      return '/images/container-intro.png';
    }
    return '/images/docker-motivation.png';
  }
  
  if (textToSearch.includes('security') || textToSearch.includes('cyber') || textToSearch.includes('owasp') || textToSearch.includes('pentest') || textToSearch.includes('angriff') || textToSearch.includes('hack') || textToSearch.includes('passwort') || textToSearch.includes('auth')) {
    return '/images/cybersecurity.png';
  }

  if (textToSearch.includes('db') || textToSearch.includes('database') || textToSearch.includes('datenbank') || textToSearch.includes('postgres') || textToSearch.includes('sql') || textToSearch.includes('nosql') || textToSearch.includes('server') || textToSearch.includes('cloud')) {
    return '/images/database.png';
  }

  return '/images/coding.png';
}

function getSlideSpeechScript(fullScript, slideIndex, totalSlides) {
  if (!fullScript) return '';
  
  // Split by double newline or single newline if double isn't used
  let paragraphs = fullScript.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  if (paragraphs.length < 2) {
    paragraphs = fullScript.split(/\n/).map(p => p.trim()).filter(Boolean);
  }
  
  if (paragraphs.length === 0) return '';
  if (totalSlides <= 1) return fullScript;
  
  // Distribute paragraphs to slides evenly
  const numParagraphs = paragraphs.length;
  const avg = numParagraphs / totalSlides;
  
  const startIdx = Math.floor(slideIndex * avg);
  const endIdx = (slideIndex === totalSlides - 1) ? numParagraphs : Math.floor((slideIndex + 1) * avg);
  
  return paragraphs.slice(startIdx, endIdx).join('\n\n');
}

function toggleFullscreen() {
  const container = document.getElementById('lesson-media-container');
  if (!container) return;

  if (!document.fullscreenElement) {
    container.requestFullscreen().then(() => {
      container.classList.add('fullscreen-active');
    }).catch((err) => {
      console.error(`Error attempting to enable fullscreen: ${err.message}`);
    });
  } else {
    document.exitFullscreen();
  }
}

document.addEventListener('fullscreenchange', () => {
  const container = document.getElementById('lesson-media-container');
  const btn = document.getElementById('video-fullscreen-btn');
  if (!container) return;
  
  const isFS = !!document.fullscreenElement;
  container.classList.toggle('fullscreen-active', isFS);
  
  if (btn) {
    const icon = btn.querySelector('i');
    if (isFS) {
      btn.setAttribute('title', 'Vollbild beenden');
      if (icon) icon.setAttribute('data-lucide', 'minimize');
    } else {
      btn.setAttribute('title', 'Vollbildmodus');
      if (icon) icon.setAttribute('data-lucide', 'maximize');
    }
    lucide.createIcons();
  }
});


