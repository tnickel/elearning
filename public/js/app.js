// State management
// Token/user live in sessionStorage (not localStorage) to reduce the impact
// of XSS token theft; localStorage is only read once for migration.
let state = {
  token: sessionStorage.getItem('token') || localStorage.getItem('token') || null,
  user: JSON.parse(sessionStorage.getItem('user') || 'null') || JSON.parse(localStorage.getItem('user') || 'null'),
  courses: [],
  activeCourse: null,
  activeLesson: null,
  sessionId: null,
  heartbeatInterval: null,
  lastActivityTime: Date.now(),
  userActive: true,
  hashChain: [],
  isDeleting: false,
  adminConfigLoaded: false,
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

  const DEMO_TENANT = 'de305d54-75b4-431b-adb2-eb6b9e546014';
  const demoUsersList = [
    { email: 'admin@tenant-alpha.com', role: 'admin', tenantId: DEMO_TENANT },
    { email: 'student@tenant-alpha.com', role: 'student', tenantId: DEMO_TENANT }
  ];

  quickSelect.innerHTML = '<option value="">-- Benutzer auswählen (Auto-Login) --</option>';
  demoUsersList.forEach(u => {
    const opt = document.createElement('option');
    opt.value = JSON.stringify(u);
    opt.textContent = `${u.email} (${u.role === 'admin' ? 'Admin' : 'Schüler'})`;
    quickSelect.appendChild(opt);
  });

  quickSelect.onchange = (e) => {
    const val = e.target.value;
    if (!val) return;
    try {
      const userData = JSON.parse(val);
      document.getElementById('login-email').value = userData.email;
      document.getElementById('login-tenant').value = userData.tenantId;
      document.getElementById('login-role').value = userData.role;
      handleLogin({ preventDefault: () => {} });
    } catch (err) {
      console.error('Quick select error:', err);
    }
  };
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

  // Admin: Course Generator form (Option A)
  const courseGenForm = document.getElementById('course-generator-form');
  if (courseGenForm) courseGenForm.addEventListener('submit', handleGenerateCourse);

  // Admin: Concept Generator form (Option C)
  const conceptGenForm = document.getElementById('concept-generator-form');
  if (conceptGenForm) conceptGenForm.addEventListener('submit', handleGenerateConcept);

  // Admin: Config form
  document.getElementById('admin-config-form').addEventListener('submit', handleSaveConfig);

  // Admin: Test OpenRouter Key button
  document.getElementById('btn-test-openrouter').addEventListener('click', handleTestOpenRouter);

  // Admin: Test ElevenLabs Key button
  document.getElementById('btn-test-elevenlabs').addEventListener('click', handleTestElevenLabs);

  // Admin: Test MiniMax Key button
  document.getElementById('btn-test-minimax').addEventListener('click', handleTestMiniMax);

  // Admin: Test Zhipu Key button
  const btnTestZhipu = document.getElementById('btn-test-zhipu');
  if (btnTestZhipu) btnTestZhipu.addEventListener('click', handleTestZhipu);

  // Admin: Toggle Config Header
  document.getElementById('admin-config-header').addEventListener('click', toggleConfigPanel);

  // Admin: Toggle Prompts Header
  const adminPromptsHeader = document.getElementById('admin-prompts-header');
  if (adminPromptsHeader) {
    adminPromptsHeader.addEventListener('click', togglePromptsPanel);
  }

  // Admin: Verify Chain button
  document.getElementById('verify-chain-btn').addEventListener('click', handleVerifyChain);

  // Student: Back to courses (or admin dashboard if admin was previewing)
  document.getElementById('back-to-courses').addEventListener('click', () => {
    stopHeartbeats();
    document.getElementById('classroom-view').classList.add('hidden');
    if (state.user?.role === 'admin') {
      document.getElementById('student-dashboard').classList.add('hidden');
      document.getElementById('student-courses-grid').classList.remove('hidden');
      document.getElementById('admin-dashboard').classList.remove('hidden');
      loadAdminDashboard();
    } else {
      document.getElementById('student-courses-grid').classList.remove('hidden');
      loadStudentDashboard();
    }
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
  document.addEventListener('play', recordActivity, true);
  document.addEventListener('timeupdate', recordActivity, true);

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

    if (role === 'admin' && data.user?.role !== 'admin') {
      alert(
        'Admin-Anmeldung abgelehnt: Diese E-Mail ist nicht für Admin freigeschaltet.\n\n' +
        'Bitte Quick-Login „admin@tenant-alpha.com (Admin)“ wählen,\n' +
        'oder ADMIN_EMAILS in der .env um deine Adresse erweitern.\n\n' +
        'Du bist jetzt als Schüler angemeldet.'
      );
    }

    sessionStorage.setItem('token', data.token);
    sessionStorage.setItem('user', JSON.stringify(data.user));
    // Clean up any legacy localStorage copy from older versions
    localStorage.removeItem('token');
    localStorage.removeItem('user');

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
  sessionStorage.removeItem('token');
  sessionStorage.removeItem('user');
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
      grid.innerHTML = '<p class="subtitle">Bisher wurden keine Kurse freigegeben. Bitte wenden Sie sich an den Admin.</p>';
      return;
    }

    grid.innerHTML = '';
    courses.forEach(course => {
      const card = document.createElement('div');
      card.className = 'glass-card course-card';
      card.onclick = () => selectCourse(course.id);
      
      card.innerHTML = `
        <div>
          <h4>${escapeHtml(course.topic)}</h4>
          <p class="subtitle">Erstellt: ${new Date(course.createdAt).toLocaleDateString()}</p>
        </div>
        <div class="course-status-wrapper" style="display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 8px;">
          <span class="status-dot active"></span>
          <span style="font-size: 0.85rem;">Freigegeben – jetzt starten</span>
        </div>
      `;
      grid.appendChild(card);
    });
    lucide.createIcons();
  } catch (err) {
    console.error('Failed to load student courses:', err.message);
  }
}

async function enterClassroom(courseId) {
  const courseDetails = await apiCall(`/courses/${courseId}`);
  state.activeCourse = courseDetails.course;

  document.getElementById('student-courses-grid').classList.add('hidden');
  document.getElementById('classroom-view').classList.remove('hidden');
  document.getElementById('student-dashboard').classList.remove('hidden');

  document.getElementById('classroom-course-title').textContent = state.activeCourse.topic;

  const modulesList = document.getElementById('classroom-modules-list');
  modulesList.innerHTML = '';

  courseDetails.modules.forEach(mod => {
    const modGroup = document.createElement('div');
    modGroup.className = 'module-group';
    modGroup.innerHTML = `<h5>${escapeHtml(mod.title)}</h5>`;

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
        <span>${escapeHtml(les.title)}</span>
      `;
      lessonsList.appendChild(item);
    });
    modGroup.appendChild(lessonsList);
    modulesList.appendChild(modGroup);
  });

  lucide.createIcons();

  if (courseDetails.lessons.length > 0) {
    selectLesson(courseDetails.lessons[0], courseDetails.lessons);
  }
}

async function selectCourse(courseId) {
  try {
    const courseDetails = await apiCall(`/courses/${courseId}`);
    state.activeCourse = courseDetails.course;

    if (state.user.role !== 'admin') {
      if (state.activeCourse.status === 'generating') {
        alert('Dieser Kurs wird gerade generiert. Bitte gedulden Sie sich.');
        return;
      }
      if (state.activeCourse.status === 'pending_approval' || state.activeCourse.status === 'content_draft' || state.activeCourse.status === 'curriculum_draft') {
        alert('Dieser Kurs wartet auf die Freigabe durch den Administrator.');
        return;
      }
      if (state.activeCourse.status === 'failed') {
        alert('Die Generierung dieses Kurses ist fehlgeschlagen.');
        return;
      }
      if (state.activeCourse.status !== 'active') {
        alert('Dieser Kurs ist noch nicht freigegeben.');
        return;
      }
    }

    await enterClassroom(courseId);
  } catch (err) {
    alert('Fehler beim Laden des Kurses: ' + err.message);
  }
}

async function playCourseAdmin(courseId) {
  try {
    document.getElementById('admin-dashboard').classList.add('hidden');
    document.getElementById('student-dashboard').classList.remove('hidden');
    await enterClassroom(courseId);
  } catch (err) {
    document.getElementById('admin-dashboard').classList.remove('hidden');
    document.getElementById('student-dashboard').classList.add('hidden');
    alert('Kurs konnte nicht abgespielt werden: ' + err.message);
  }
}

const exportPollers = {};

function setExportProgressUi(courseId, percent, label, { done = false, failed = false } = {}) {
  const pct = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  const text = label || 'MP4-Export…';

  const studioOpen =
    pptxStudio.courseId === courseId &&
    document.getElementById('pptx-studio-modal') &&
    !document.getElementById('pptx-studio-modal').classList.contains('hidden');

  const studioBox = document.getElementById('pptx-export-progress');
  const studioBar = document.getElementById('pptx-export-progress-bar');
  const studioPct = document.getElementById('pptx-export-progress-percent');
  const studioLabel = document.getElementById('pptx-export-progress-label');
  const studioStatus = document.getElementById('pptx-studio-batch-status');
  const exportBtn = document.getElementById('pptx-btn-export-mp4');

  const toast = document.getElementById('export-progress-toast');
  const toastBar = document.getElementById('export-progress-toast-bar');
  const toastPct = document.getElementById('export-progress-toast-percent');
  const toastLabel = document.getElementById('export-progress-toast-label');

  if (studioOpen && studioBox) {
    studioBox.classList.remove('hidden');
    if (studioBar) studioBar.style.width = `${pct}%`;
    if (studioPct) studioPct.textContent = `${pct}%`;
    if (studioLabel) studioLabel.textContent = text;
    if (studioStatus) studioStatus.textContent = text;
    if (exportBtn) exportBtn.disabled = !(done || failed);
    if (toast) toast.classList.add('hidden');
  } else if (toast) {
    toast.classList.remove('hidden');
    if (toastBar) toastBar.style.width = `${pct}%`;
    if (toastPct) toastPct.textContent = `${pct}%`;
    if (toastLabel) toastLabel.textContent = text;
    lucide.createIcons();
  }

  if ((done || failed) && studioBox && studioOpen) {
    if (failed) {
      studioBox.style.background = 'rgba(239, 68, 68, 0.08)';
    } else {
      studioBox.style.background = 'rgba(16, 185, 129, 0.06)';
    }
  }

  if (done || failed) {
    setTimeout(() => {
      if (done && toast) toast.classList.add('hidden');
      if (failed && toast) {
        /* keep toast briefly visible on failure; hide after delay */
        setTimeout(() => toast.classList.add('hidden'), 4000);
      }
      if (done && studioOpen && studioBox) {
        setTimeout(() => studioBox.classList.add('hidden'), 2500);
      }
      if (exportBtn) exportBtn.disabled = false;
    }, done ? 800 : 0);
  }
}

function hideExportProgressUi() {
  const studioBox = document.getElementById('pptx-export-progress');
  const toast = document.getElementById('export-progress-toast');
  const exportBtn = document.getElementById('pptx-btn-export-mp4');
  if (studioBox) studioBox.classList.add('hidden');
  if (toast) toast.classList.add('hidden');
  if (exportBtn) exportBtn.disabled = false;
}

async function exportCourseMp4(courseId) {
  if (!courseId) return;
  if (exportPollers[courseId]) {
    alert('Export läuft bereits.');
    return;
  }

  if (!confirm('Alle Folien inkl. Vertonung als ein MP4-Video exportieren? Das kann einige Minuten dauern.')) {
    return;
  }

  try {
    setExportProgressUi(courseId, 1, 'Starte MP4-Export…');
    await apiCall(`/courses/${courseId}/export-mp4`, { method: 'POST' });
    setExportProgressUi(courseId, 3, 'Export läuft…');

    let tries = 0;
    exportPollers[courseId] = setInterval(async () => {
      tries++;
      try {
        const st = await apiCall(`/courses/${courseId}/export-mp4/status`);
        const pct = typeof st.percent === 'number' ? st.percent : Math.min(95, tries * 2);
        const label = st.step || 'Export läuft…';
        setExportProgressUi(courseId, pct, label);

        if (st.status === 'ready' && st.downloadUrl) {
          clearInterval(exportPollers[courseId]);
          delete exportPollers[courseId];
          setExportProgressUi(courseId, 100, 'MP4 fertig – Download startet…', { done: true });
          const a = document.createElement('a');
          a.href = st.downloadUrl;
          a.download = st.downloadUrl.split('/').pop() || 'kurs.mp4';
          document.body.appendChild(a);
          a.click();
          a.remove();
          loadAdminDashboard();
        } else if (st.status === 'failed') {
          clearInterval(exportPollers[courseId]);
          delete exportPollers[courseId];
          setExportProgressUi(courseId, pct, st.error || st.step || 'Export fehlgeschlagen', { failed: true });
          alert('MP4-Export fehlgeschlagen: ' + (st.error || st.step || 'Unbekannter Fehler'));
        } else if (tries > 180) {
          clearInterval(exportPollers[courseId]);
          delete exportPollers[courseId];
          setExportProgressUi(courseId, pct, 'Export-Timeout – bitte später erneut prüfen', { failed: true });
          alert('Export dauert ungewöhnlich lange. Bitte später erneut prüfen.');
        }
      } catch (err) {
        if (tries > 8) {
          clearInterval(exportPollers[courseId]);
          delete exportPollers[courseId];
          setExportProgressUi(courseId, 0, 'Export-Status nicht lesbar', { failed: true });
          alert('Fehler beim Abfragen des Exports: ' + err.message);
        }
      }
    }, 1500);
  } catch (err) {
    hideExportProgressUi();
    alert('MP4-Export konnte nicht gestartet werden: ' + err.message);
  }
}

function renderLessonPractice(payload) {
  const el = document.getElementById('lesson-practice');
  if (!el) return;

  const exercise = payload?.exercise;
  const boilerplate = exercise?.boilerplate || {};
  const solution = exercise?.solution || {};
  const criteria = exercise?.validation_criteria || [];
  const fileNames = Object.keys(boilerplate);

  if (!exercise || fileNames.length === 0) {
    el.innerHTML = '<p class="subtitle">Keine Programmieraufgabe für diese Lektion.</p>';
    return;
  }

  const title = escapeHtml(exercise.exercise_title || exercise.title || 'Programmieraufgabe');
  let html = `<h4 style="margin-top:0;">${title}</h4>`;

  if (exercise.difficulty_level) {
    html += `<p class="subtitle">Niveau: ${escapeHtml(exercise.difficulty_level)}</p>`;
  }

  html += '<h5>Starter-Code</h5>';
  for (const fname of fileNames) {
    html += `<div class="practice-file">
      <div class="practice-file-name"><code>${escapeHtml(fname)}</code></div>
      <pre class="practice-code"><code>${escapeHtml(boilerplate[fname] || '')}</code></pre>
    </div>`;
  }

  if (Array.isArray(criteria) && criteria.length > 0) {
    html += '<h5>Akzeptanzkriterien</h5><ul class="practice-criteria">';
    for (const c of criteria) {
      html += `<li>${escapeHtml(typeof c === 'string' ? c : JSON.stringify(c))}</li>`;
    }
    html += '</ul>';
  }

  const solNames = Object.keys(solution);
  if (solNames.length > 0) {
    html += `<details class="practice-solution">
      <summary>Musterlösung anzeigen</summary>`;
    for (const fname of solNames) {
      html += `<div class="practice-file">
        <div class="practice-file-name"><code>${escapeHtml(fname)}</code></div>
        <pre class="practice-code"><code>${escapeHtml(solution[fname] || '')}</code></pre>
      </div>`;
    }
    html += '</details>';
  } else if (exercise.has_solution) {
    html += '<p class="subtitle">Eine Musterlösung ist hinterlegt, wird Schülerinnen und Schülern aber nicht ausgeliefert (nur Starter-Code).</p>';
  }

  el.innerHTML = html;
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

  // Praxis / Coding exercise panel
  renderLessonPractice(payload);

  // Media player: unique per-lesson audio/video + slide stage for audio-only
  setupLessonMediaPlayer(lesson);

  // Load Quiz
  const quizContainer = document.getElementById('lesson-quiz');
  quizContainer.innerHTML = '';

  if (payload.quiz && payload.quiz.length > 0) {
    // Quiz answers are stripped from the student payload: correctness and the
    // explanation are evaluated server-side via /quiz-submit.
    payload.quiz.forEach((q, qIndex) => {
      const qBlock = document.createElement('div');
      qBlock.className = 'quiz-question-block';
      qBlock.innerHTML = `<h5>Frage ${qIndex + 1}: ${escapeHtml(q.question)}</h5>`;

      const optionsDiv = document.createElement('div');
      optionsDiv.className = 'quiz-options';

      (q.options || []).forEach((opt, oIndex) => {
        const optBtn = document.createElement('div');
        optBtn.className = 'quiz-option';
        optBtn.textContent = opt;
        optBtn.onclick = () => submitQuizAnswer(optBtn, oIndex, qIndex, lesson.id);
        optionsDiv.appendChild(optBtn);
      });

      qBlock.appendChild(optionsDiv);
      quizContainer.appendChild(qBlock);
    });
  } else {
    quizContainer.innerHTML = '<p class="subtitle">Kein Wissenstest für diese Lektion verfügbar.</p>';
  }

  // Start tamper-proof time-tracking (one chain per course entry, kept alive
  // across lesson switches)
  startHeartbeats();
}

// Tamper-proof Heartbeat loop
function startHeartbeats() {
  // One chain per course entry: switching lessons must NOT start a new session
  // and wipe the visible chain (fragmented audit trail otherwise).
  if (state.heartbeatInterval) {
    return;
  }

  state.sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  state.hashChain = [];
  document.getElementById('active-session-id').textContent = state.sessionId;
  document.getElementById('session-hash-chain').innerHTML = '';

  // Matches the documented AZAV/AVGS heartbeat cadence (Handbook: ca. 15-30s).
  const intervalTime = 30000;

  console.log(`Starting heartbeat chain for session: ${state.sessionId}`);

  state.heartbeatInterval = setInterval(async () => {
    // Check if media (audio/video) is playing (Befund 24)
    const mediaElements = document.querySelectorAll('video, audio');
    let isPlaying = false;
    for (const m of mediaElements) {
      if (!m.paused && !m.ended && m.currentTime > 0) {
        isPlaying = true;
        break;
      }
    }
    if (isPlaying) {
      state.lastActivityTime = Date.now();
    }

    // A hidden tab only accrues learning time while media is actually playing
    if (document.hidden && !isPlaying) {
      console.log('Heartbeat skipped: tab hidden and no media playing.');
      return;
    }

    // Check if user is active (DOM events or media playback detected recently)
    const inactiveDuration = Date.now() - state.lastActivityTime;
    if (inactiveDuration > 45000) {
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

async function submitQuizAnswer(element, selectedIdx, questionIndex, lessonId) {
  // Disable option changes
  const parent = element.parentElement;
  if (parent.querySelector('.correct') || parent.querySelector('.incorrect')) return;

  element.classList.add('selected');

  const courseId = state.activeCourse?.id;
  let result;
  try {
    result = await apiCall(`/courses/${courseId}/lessons/${lessonId}/quiz-submit`, {
      method: 'POST',
      body: JSON.stringify({ questionIndex, selectedIndex: selectedIdx }),
    });
  } catch (err) {
    element.classList.remove('selected');
    alert('Antwort konnte nicht geprüft werden: ' + err.message);
    return;
  }

  const { isCorrect, correctIndex, explanation } = result;

  setTimeout(() => {
    parent.querySelectorAll('.quiz-option').forEach((opt, idx) => {
      if (idx === correctIndex) {
        opt.classList.add('correct');
      } else if (idx === selectedIdx) {
        opt.classList.add('incorrect');
      }
    });

    // Add explanation
    const expDiv = document.createElement('div');
    expDiv.className = 'quiz-explanation';
    expDiv.textContent = isCorrect
      ? `Richtig! Erklärung: ${explanation}`
      : `Leider falsch. Erklärung: ${explanation}`;
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
        response.contextUsed.map(s => `${escapeHtml(s.title)} (Score: ${(s.similarity * 100).toFixed(1)}%)`).join(', ') +
        `</div>`;
    }

    tutorMsg.innerHTML = `
      <div>${formatMarkdown(response.answer)}</div>
      ${sourcesText}
    `;
    chatMessages.appendChild(tutorMsg);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  } catch (err) {
    chatMessages.removeChild(thinkingMsg);
    alert('Fehler beim Abfragen des Tutors: ' + err.message);
  }
}

// Helper to escape HTML characters
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Helper to format simple markdown highlights securely
function formatMarkdown(text) {
  if (!text) return '';
  const safeText = escapeHtml(text);
  return safeText
    .replace(/^# (.*$)/gim, '<h1>$1</h1>')
    .replace(/^## (.*$)/gim, '<h2>$1</h2>')
    .replace(/^### (.*$)/gim, '<h3>$1</h3>')
    .replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/gim, '<em>$1</em>')
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

        const isConceptOnly = course.progress?.mode === 'concept';

        const pipelineCell = isConceptOnly
          ? `<span class="concept-badge" title="Didaktischer Rahmenlehrplan"><i data-lucide="compass" style="width:12px;height:12px;display:inline-block;vertical-align:middle;margin-right:4px;"></i>Rahmen</span>`
          : `
          <div class="pipeline-checks">
            ${checkItem(!!pipe.slidesReady, 'Folien')}
            ${checkItem(!!pipe.narrationsReady, 'Sprechtext')}
            ${checkItem(!!pipe.audioReady, 'Vertonung')}
          </div>`;
        
        let statusLabels = '';
        if (isConceptOnly) {
          if (course.status === 'concept_generating') {
            const prog = course.progress || { percent: 15, step: 'Konzept wird generiert...' };
            statusLabels = `
              <div style="width: 100%; max-width: 220px;">
                <span class="badge" style="background:#10b98120; color:#34d399; border:1px solid #10b98140; margin-bottom: 4px; display: inline-block; font-size: 0.75rem;">Konzept wird erstellt (${prog.percent || 15}%)</span>
                <div style="font-size: 0.72rem; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px;" title="${escapeHtml(prog.step || '')}">${escapeHtml(prog.step || '')}</div>
              </div>
            `;
          } else {
            statusLabels = '<span class="badge concept-badge" style="background:rgba(16,185,129,0.15); color:#34d399; border-color:#34d399;"><i data-lucide="compass" style="width:12px;height:12px;display:inline-block;vertical-align:middle;margin-right:4px;"></i>Konzept bereit</span>';
          }
        } else if (course.status === 'generating') {
          const prog = course.progress || { percent: 0, step: 'Gestartet' };
          statusLabels = `
            <div style="width: 100%; max-width: 220px;">
              <span class="badge" style="background:#f59e0b20; color:#f59e0b; border:1px solid #f59e0b40; margin-bottom: 4px; display: inline-block; font-size: 0.75rem;">Wird generiert (${prog.percent}%)</span>
              <div style="font-size: 0.72rem; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px;" title="${escapeHtml(prog.step)}">${escapeHtml(prog.step)}</div>
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
          }[course.status] || `<span class="badge">${course.status}</span>`;
        }

        const durationParam = (course.progress && course.progress.duration) ? course.progress.duration : '';
        // jsAttr: makes the topic safe both as an HTML attribute value and as a
        // single-quoted JS string inside the onclick handler.
        const jsAttr = (s) => escapeHtml(String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[\r\n]+/g, ' '));
        const openBtn = isPptx
          ? `<button class="btn btn-primary btn-sm" onclick="openPptxStudio('${course.id}')" title="Folien-Wizard öffnen"><i data-lucide="presentation"></i> Folien-Wizard</button>`
          : `<button class="btn btn-secondary btn-sm" onclick="openWizard('${course.id}', '${jsAttr(course.topic)}', '${durationParam}')" title="Inhalte & Skripte bearbeiten"><i data-lucide="edit-3"></i> Wizard</button>`;
        const playBtn = `<button class="btn btn-secondary btn-sm" onclick="playCourseAdmin('${course.id}')" title="Vorschau & Abspielen"><i data-lucide="play"></i> Abspielen</button>`;
        const exportBtn = `<button class="btn btn-secondary btn-sm" onclick="exportCourseMp4('${course.id}')" title="MP4 Video exportieren"><i data-lucide="download"></i> MP4</button>`;
        const deleteBtn = `<button class="btn btn-sm btn-delete" onclick="handleDeleteCourse('${course.id}')" title="Kurs löschen"><i data-lucide="trash-2"></i> Löschen</button>`;

        let actionBtn = '';
        if (isConceptOnly) {
          const pdfUrl = (course.progress && course.progress.pdfUrl) ? course.progress.pdfUrl : `/course_output/${course.id}/didaktisches_konzept.pdf`;
          actionBtn = `
            <div class="course-actions-bar">
              <button class="btn btn-secondary btn-sm" onclick="openConceptPreviewModal('${course.id}')" title="Didaktisches Konzept ansehen" style="border-color:#34d399; color:#34d399;">
                <i data-lucide="eye"></i> Konzept
              </button>
              <a href="${pdfUrl}" target="_blank" class="btn btn-primary btn-sm" title="PDF-Dokument öffnen/herunterladen" style="background: linear-gradient(135deg, #059669, #10b981); border-color:#34d399; color:#fff; text-decoration:none; display:inline-flex; align-items:center; gap:4px;">
                <i data-lucide="file-down"></i> PDF
              </a>
              ${deleteBtn}
            </div>
          `;
        } else
        if (course.status === 'curriculum_draft' || course.status === 'content_draft') {
          actionBtn = `
            <div class="course-actions-bar">
              ${openBtn}
              ${playBtn}
              ${exportBtn}
              ${deleteBtn}
            </div>
          `;
        } else if (course.status === 'pending_approval') {
          actionBtn = `
            <div class="course-actions-bar">
              <button class="btn btn-primary btn-sm" onclick="handleApproveCourse('${course.id}')" title="Für Schüler freigeben"><i data-lucide="check-square"></i> Freigeben</button>
              ${openBtn}
              ${playBtn}
              ${exportBtn}
              ${deleteBtn}
            </div>
          `;
        } else if (course.status === 'generating') {
          actionBtn = `
            <div class="course-actions-bar">
              <button class="btn btn-sm btn-delete" onclick="handleStopCourse('${course.id}')"><i data-lucide="square"></i> Stoppen</button>
            </div>
          `;
        } else {
          actionBtn = `
            <div class="course-actions-bar">
              ${playBtn}
              ${exportBtn}
              ${openBtn}
              ${deleteBtn}
            </div>
          `;
        }

        row.innerHTML = `
          <td><strong>${escapeHtml(course.topic)}</strong></td>
          <td>${pipelineCell}</td>
          <td>${statusLabels}</td>
          <td>${new Date(course.createdAt).toLocaleString()}</td>
          <td>${actionBtn}</td>
        `;
        tableBody.appendChild(row);
      });
    }

    // Load config values into form fields once (prevent poll from overwriting unsaved choices)
    if (!state.adminConfigLoaded) {
      const config = await apiCall('/admin/config');
      document.getElementById('cfg-generate-video').value = config.GENERATE_VIDEO || 'false';
      document.getElementById('cfg-video-provider').value = config.VIDEO_PROVIDER || 'elevenlabs';
      document.getElementById('cfg-tts-provider').value = config.TTS_PROVIDER || 'elevenlabs';
      document.getElementById('cfg-llm-provider').value = config.LLM_PROVIDER || 'openrouter';
      document.getElementById('cfg-openrouter-model').value = config.OPENROUTER_MODEL || 'google/gemini-2.5-pro';
      document.getElementById('cfg-openrouter-key').value = config.OPENROUTER_API_KEY || '';
      document.getElementById('cfg-zhipu-key').value = config.ZHIPU_API_KEY || '';
      document.getElementById('cfg-zhipu-model').value = config.ZHIPU_MODEL || 'glm-5.3';
      document.getElementById('cfg-zhipu-vision-model').value = config.ZHIPU_VISION_MODEL || 'glm-5.3-flash';
      document.getElementById('cfg-zhipu-embedding-model').value = config.ZHIPU_EMBEDDING_MODEL || 'embedding-3';
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

      state.adminConfigLoaded = true;
      // Update 2-step wizard state and badges
      setTimeout(() => {
        updateConfigUiState();
      }, 0);
    }
    
    // Populate the verification drop-down with REAL sessions from the backend
    // (no demo/fake entries: the audit UI must only ever show actual data).
    try {
      const sessions = await apiCall('/time-tracking/sessions');
      (sessions || []).forEach(sess => {
        if (!sess || !sess.sessionId) return;
        const opt = document.createElement('option');
        opt.value = sess.sessionId;
        const mins = Math.floor((sess.totalDurationSec || 0) / 60);
        const secs = (sess.totalDurationSec || 0) % 60;
        opt.textContent = `${sess.sessionId} (${sess.blocks} Blöcke, ${mins}m ${secs}s)`;
        sessionSelector.appendChild(opt);
      });
    } catch (err) {
      console.warn('Sessionliste konnte nicht geladen werden:', err.message);
    }

    // Also populate with the student's session if active
    if (state.sessionId) {
      const opt = document.createElement('option');
      opt.value = state.sessionId;
      opt.textContent = `${state.sessionId} (Aktuelle Sitzung)`;
      sessionSelector.appendChild(opt);
    }

    // Load prompt templates if not already loaded
    if (!promptState.prompts || promptState.prompts.length === 0) {
      loadAdminPrompts();
    }

    lucide.createIcons();
  } catch (err) {
    console.error('Failed to load admin dashboard:', err.message);
  }
}

window.onIndexDurationChange = function() {
  const sel = document.getElementById('course-duration');
  const customBox = document.getElementById('index-custom-weeks-box');
  if (sel && customBox) {
    if (sel.value === 'custom') {
      customBox.style.display = 'flex';
    } else {
      customBox.style.display = 'none';
    }
  }
};

function selectCreationMode(mode) {
  const cardFull = document.getElementById('card-mode-full');
  const cardPptx = document.getElementById('card-mode-pptx');
  const cardConcept = document.getElementById('card-mode-concept');

  const paneFull = document.getElementById('pane-mode-full');
  const panePptx = document.getElementById('pane-mode-pptx');
  const paneConcept = document.getElementById('pane-mode-concept');

  const hintFull = document.getElementById('hint-text-full');
  const hintPptx = document.getElementById('hint-text-pptx');
  const hintConcept = document.getElementById('hint-text-concept');

  const panesWrapper = document.getElementById('creation-panes-wrapper');
  const bridgeTagText = document.getElementById('bridge-tag-text');
  const bridgeTitle = document.getElementById('bridge-title');
  const bridgeDesc = document.getElementById('bridge-desc');

  // Trigger glowing border flash on clicked tile
  const cards = [cardFull, cardPptx, cardConcept];
  cards.forEach(c => {
    if (c) c.classList.remove('flash-border');
  });

  const activeCard = mode === 'full' ? cardFull : (mode === 'pptx' ? cardPptx : cardConcept);
  if (activeCard) {
    void activeCard.offsetWidth; // Force reflow to immediately replay animation
    activeCard.classList.add('flash-border');
    setTimeout(() => {
      activeCard.classList.remove('flash-border');
    }, 780);
  }

  if (cardFull) cardFull.classList.toggle('active', mode === 'full');
  if (cardPptx) cardPptx.classList.toggle('active', mode === 'pptx');
  if (cardConcept) cardConcept.classList.toggle('active', mode === 'concept');

  if (paneFull) paneFull.classList.toggle('active', mode === 'full');
  if (panePptx) panePptx.classList.toggle('active', mode === 'pptx');
  if (paneConcept) paneConcept.classList.toggle('active', mode === 'concept');

  // Update dynamic mode class on wrapper for matching border/glow
  if (panesWrapper) {
    panesWrapper.className = `creation-panes-wrapper mode-${mode}`;
  }

  // Update button texts
  if (hintFull) hintFull.textContent = mode === 'full' ? '✓ Ausgewählt (Eingabe unten aktiv)' : 'Diese Option wählen';
  if (hintPptx) hintPptx.textContent = mode === 'pptx' ? '✓ Ausgewählt (Eingabe unten aktiv)' : 'Diese Option wählen';
  if (hintConcept) hintConcept.textContent = mode === 'concept' ? '✓ Ausgewählt (Eingabe unten aktiv)' : 'Diese Option wählen';

  // Update bridge connection banner
  if (bridgeTagText && bridgeTitle && bridgeDesc) {
    if (mode === 'full') {
      bridgeTagText.textContent = 'GEWÄHLTE OPTION: A (VOLLAUTOMATISCH)';
      bridgeTitle.textContent = 'Eingabe-Formular für: Option A · Vollautomatischer KI-Kurs';
      bridgeDesc.textContent = 'Erstellt Lehrplan, Folieninhalte, Audio-Vertonung und Prüfungsaufgaben.';
    } else if (mode === 'pptx') {
      bridgeTagText.textContent = 'GEWÄHLTE OPTION: B (POWERPOINT 1:1)';
      bridgeTitle.textContent = 'Upload & Wizard für: Option B · PowerPoint 1:1 Import';
      bridgeDesc.textContent = 'Lade eine .pptx-Präsentation hoch – die Folien werden 1:1 übernommen und im Studio vertont.';
    } else {
      bridgeTagText.textContent = 'GEWÄHLTE OPTION: C (SCHNELL-RAHMEN)';
      bridgeTitle.textContent = 'Eingabe-Formular für: Option C · Didaktisches Rahmenkonzept';
      bridgeDesc.textContent = 'Definiere Thema und Ziel-Umfang für ein didaktisches Curriculum ohne Folien & Vertonung.';
    }
  }

  if (mode === 'concept') {
    setTimeout(() => { document.getElementById('concept-topic')?.focus(); }, 120);
  } else if (mode === 'full') {
    setTimeout(() => { document.getElementById('course-topic')?.focus(); }, 120);
  }

  lucide.createIcons();
}
window.selectCreationMode = selectCreationMode;

async function handleGenerateConcept(e) {
  if (e) e.preventDefault();
  const topicInput = document.getElementById('concept-topic');
  const topic = topicInput?.value?.trim();
  const duration = document.getElementById('concept-duration')?.value || '2_weeks';
  if (!topic) return;

  const submitBtn = document.querySelector('#concept-generator-form button[type="submit"]');
  const origBtnText = submitBtn ? submitBtn.innerHTML : '';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = `<i data-lucide="loader-2" class="animate-spin" style="width:16px;height:16px;display:inline-block;vertical-align:middle;margin-right:6px;"></i> Konzeptioniere stufenweise...`;
    lucide.createIcons();
  }

  try {
    const res = await apiCall('/courses/generate-concept', {
      method: 'POST',
      body: JSON.stringify({ topic, duration }),
    });

    if (topicInput) topicInput.value = '';
    await loadCourses();
    openConceptPreviewModal(res.courseId, res.concept, res.pdfUrl);
  } catch (err) {
    alert('Fehler bei der stufenweisen Konzept-Generierung: ' + err.message);
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = origBtnText;
      lucide.createIcons();
    }
  }
}
window.handleGenerateConcept = handleGenerateConcept;

async function openConceptPreviewModal(courseId, conceptData = null, pdfUrl = null) {
  const modal = document.getElementById('modal-concept-preview');
  if (!modal) return;

  try {
    let data = conceptData;
    let effectivePdfUrl = pdfUrl;
    if (!data) {
      const res = await apiCall(`/courses/${courseId}/concept`);
      data = {
        course_title: res.topic,
        total_ue: res.progress?.total_ue || 80,
        duration_desc: res.progress?.duration_desc || res.progress?.duration || '',
        target_audience: res.progress?.target_audience || 'IT-Fachkräfte & Quereinsteiger',
        prerequisites: res.progress?.prerequisites || 'Grundkenntnisse',
        didactic_approach: res.progress?.didactic_approach || 'Blended Learning & Hands-On Labs',
        executive_summary: res.progress?.executive_summary || '',
        modules: res.modules || [],
      };
      effectivePdfUrl = res.pdfUrl || `/course_output/${courseId}/didaktisches_konzept.pdf`;
    }

    // Populate metadata
    document.getElementById('concept-modal-title').textContent = data.course_title || 'Didaktisches Rahmenkonzept';
    document.getElementById('concept-modal-duration-tag').textContent = data.duration_desc ? `• ${data.duration_desc}` : '';
    document.getElementById('concept-modal-ue').textContent = `${data.total_ue || 80} UE`;
    document.getElementById('concept-modal-target').textContent = data.target_audience || '--';
    document.getElementById('concept-modal-prereq').textContent = data.prerequisites || '--';
    document.getElementById('concept-modal-didactic').textContent = data.didactic_approach || '--';
    document.getElementById('concept-modal-summary').textContent = data.executive_summary || 'Keine Kurzbeschreibung verfügbar.';

    // PDF button link
    const pdfBtn = document.getElementById('btn-download-concept-pdf');
    if (pdfBtn) {
      const href = effectivePdfUrl || `/course_output/${courseId}/didaktisches_konzept.pdf`;
      pdfBtn.setAttribute('href', href);
    }

    // Render modules
    const modulesContainer = document.getElementById('concept-modal-modules-list');
    if (modulesContainer) {
      modulesContainer.innerHTML = '';
      const modules = data.modules || [];
      modules.forEach((mod, idx) => {
        const wNum = mod.week_number || (idx + 1);
        const modEl = document.createElement('div');
        modEl.style.cssText = 'background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; overflow: hidden;';

        const lessonsHtml = (mod.lessons || []).map((les, lIdx) => {
          const objectives = les.learning_objectives || [];
          const objectivesHtml = objectives.length > 0 ? objectives.map(o => `
            <div style="display:flex; align-items:flex-start; gap:8px; margin-bottom:4px; font-size:0.83rem; color:#cbd5e1;">
              <i data-lucide="check" style="width:14px; height:14px; color:#34d399; flex-shrink:0; margin-top:2px;"></i>
              <span>${escapeHtml(o)}</span>
            </div>
          `).join('') : '';

          const exerciseHtml = les.practical_exercise ? `
            <div style="margin-top: 8px; padding: 8px 12px; background: rgba(16, 185, 129, 0.05); border-left: 2px solid #34d399; border-radius: 0 4px 4px 0; font-size: 0.8rem; color: #94a3b8;">
              <strong style="color: #34d399;">Praxistransfer & Labor:</strong> ${escapeHtml(les.practical_exercise)}
            </div>
          ` : '';

          return `
            <div style="padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,0.04); background: ${lIdx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)'}">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 6px;">
                <div style="font-weight:600; color:#fff; font-size:0.9rem;">
                  ${lIdx + 1}. ${escapeHtml(les.title)}
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                  <span style="font-size:0.75rem; color:#34d399; background:rgba(16,185,129,0.1); padding:2px 8px; border-radius:4px; border:1px solid rgba(16,185,129,0.2);">
                    ${escapeHtml(les.methodology || 'Praxis-Lab')}
                  </span>
                  <span style="font-size:0.75rem; color:#94a3b8; font-weight:600;">
                    ${les.target_ue || 8} UE
                  </span>
                </div>
              </div>
              ${les.description ? `<p style="margin:0 0 8px 0; font-size:0.84rem; color:#94a3b8; line-height:1.4;">${escapeHtml(les.description)}</p>` : ''}
              ${objectivesHtml ? `<div style="margin-top:6px;"><div style="font-size:0.75rem; font-weight:700; color:#64748b; text-transform:uppercase; margin-bottom:4px;">Kompetenzziele:</div>${objectivesHtml}</div>` : ''}
              ${exerciseHtml}
            </div>
          `;
        }).join('');

        modEl.innerHTML = `
          <div style="background: rgba(16, 185, 129, 0.08); padding: 12px 18px; border-bottom: 1px solid rgba(16, 185, 129, 0.15); display: flex; justify-content: space-between; align-items: center;">
            <div>
              <div style="font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; color: #34d399; font-weight: 700;">Woche ${wNum}</div>
              <div style="font-size: 0.95rem; font-weight: 700; color: #fff;">${escapeHtml(mod.title)}</div>
              ${mod.weekly_goal ? `<div style="font-size: 0.8rem; color: #94a3b8; margin-top: 2px;">Kernziel: ${escapeHtml(mod.weekly_goal)}</div>` : ''}
            </div>
            <div style="text-align: right;">
              <span class="badge" style="background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3);">
                ${mod.total_ue || (mod.lessons ? mod.lessons.length * 8 : 40)} UE
              </span>
            </div>
          </div>
          <div>
            ${lessonsHtml || '<div style="padding: 12px; color: #64748b; font-size: 0.85rem;">Keine Lektionen erfasst</div>'}
          </div>
        `;
        modulesContainer.appendChild(modEl);
      });
    }

    modal.classList.remove('hidden');
    lucide.createIcons();
  } catch (err) {
    alert('Fehler beim Öffnen des Konzepts: ' + err.message);
  }
}
window.openConceptPreviewModal = openConceptPreviewModal;

function closeConceptModal() {
  const modal = document.getElementById('modal-concept-preview');
  if (modal) modal.classList.add('hidden');
}
window.closeConceptModal = closeConceptModal;

async function handleGenerateCourse(e) {
  e.preventDefault();
  const topic = document.getElementById('course-topic').value;
  let duration = document.getElementById('course-duration').value;
  if (duration === 'custom') {
    const customWeeks = parseInt(document.getElementById('index-custom-weeks-input')?.value || '3', 10);
    duration = `${customWeeks}_weeks`;
  }
  if (!topic) return;

  document.getElementById('course-topic').value = '';

  try {
    const res = await apiCall('/courses/generate', {
      method: 'POST',
      body: JSON.stringify({ topic, duration, mode: 'full' }),
    });

    // Open wizard immediately at Step 1 for this new course
    openWizard(res.courseId, topic, duration, 'full');
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
      `<i data-lucide="presentation"></i> ${escapeHtml(pptxStudio.topic)}`;
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
          Sitzungs-ID: ${escapeHtml(sessionId)}<br>
          Geprüfte Heartbeats: ${res.count}<br>
          Gesamte Lernzeit: ${res.totalDurationSec ?? res.count * 30} Sekunden<br>
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
          Sitzungs-ID: ${escapeHtml(sessionId)}<br>
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
    ZHIPU_API_KEY: document.getElementById('cfg-zhipu-key').value,
    ZHIPU_MODEL: document.getElementById('cfg-zhipu-model').value,
    ZHIPU_VISION_MODEL: document.getElementById('cfg-zhipu-vision-model').value,
    ZHIPU_EMBEDDING_MODEL: document.getElementById('cfg-zhipu-embedding-model').value,
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
    state.adminConfigLoaded = false;
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

async function handleTestZhipu() {
  const apiKey = document.getElementById('cfg-zhipu-key').value;
  const statusDiv = document.getElementById('zhipu-test-status');
  const btn = document.getElementById('btn-test-zhipu');

  if (!apiKey) {
    statusDiv.style.color = '#ff6b6b';
    statusDiv.textContent = 'Bitte zuerst einen Key eintragen!';
    statusDiv.style.display = 'block';
    return;
  }

  statusDiv.style.color = '#aaa';
  statusDiv.textContent = 'Verbindung zu z.ai wird getestet...';
  statusDiv.style.display = 'block';
  btn.disabled = true;

  try {
    const res = await apiCall('/admin/config/test-zhipu', {
      method: 'POST',
      body: JSON.stringify({ apiKey }),
    });

    if (res.success) {
      state.zhipuModels = res.models || [];
      statusDiv.style.color = '#51cf66';
      statusDiv.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-top: 4px;">
          <span>
            <i class="inline-icon" data-lucide="check-circle" style="width:13px;height:13px;display:inline-block;vertical-align:middle;margin-right:4px;"></i> 
            Verbindung erfolgreich! (${res.label}, <strong>${res.modelsCount} Modelle</strong> verfügbar)
          </span>
          <button type="button" onclick="toggleZhipuModels()" style="font-size: 11px; padding: 3px 9px; border-radius: 6px; background: rgba(139,92,246,0.2); border: 1px solid rgba(139,92,246,0.4); color: #c084fc; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; font-weight: 500; transition: all 0.2s;">
            <i data-lucide="eye" style="width: 13px; height: 13px;"></i>
            <span id="zhipu-eye-btn-label">Modelle anzeigen</span>
          </button>
        </div>
        <div id="zhipu-models-container" style="display: none; margin-top: 10px; padding: 12px; background: rgba(0, 0, 0, 0.4); border: 1px solid rgba(139,92,246,0.3); border-radius: 10px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <span style="font-size: 0.75rem; color: #c084fc; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">
              Verfügbare z.ai Modelle (${res.modelsCount})
            </span>
            <span style="font-size: 0.72rem; color: var(--text-secondary);">Klicke auf Übernehmen, um ein Modell einzusetzen:</span>
          </div>
          <div id="zhipu-models-list" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; max-height: 220px; overflow-y: auto; padding-right: 4px;">
            ${(res.models || []).map(m => `
              <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 6px 8px; display: flex; flex-direction: column; gap: 4px;">
                <div style="font-size: 0.8rem; font-weight: 600; color: #fff; word-break: break-all;">${m}</div>
                <div style="display: flex; gap: 4px; margin-top: 2px;">
                  <button type="button" onclick="applyZhipuModel('${m}', 'text')" title="Als Text-Modell einsetzen" style="font-size: 9px; padding: 2px 5px; background: rgba(139,92,246,0.25); border: 1px solid rgba(139,92,246,0.5); color: #c084fc; border-radius: 3px; cursor: pointer;">Text</button>
                  <button type="button" onclick="applyZhipuModel('${m}', 'vision')" title="Als Vision-Modell einsetzen" style="font-size: 9px; padding: 2px 5px; background: rgba(6,182,212,0.25); border: 1px solid rgba(6,182,212,0.5); color: #06b6d4; border-radius: 3px; cursor: pointer;">Vision</button>
                  <button type="button" onclick="applyZhipuModel('${m}', 'embedding')" title="Als Embedding-Modell einsetzen" style="font-size: 9px; padding: 2px 5px; background: rgba(16,185,129,0.25); border: 1px solid rgba(16,185,129,0.5); color: #10b981; border-radius: 3px; cursor: pointer;">Embedding</button>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
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

function toggleZhipuModels() {
  const container = document.getElementById('zhipu-models-container');
  const label = document.getElementById('zhipu-eye-btn-label');
  if (!container) return;
  const isHidden = container.style.display === 'none';
  container.style.display = isHidden ? 'block' : 'none';
  if (label) label.textContent = isHidden ? 'Modelle ausblenden' : 'Modelle anzeigen';
  lucide.createIcons();
}
window.toggleZhipuModels = toggleZhipuModels;

function applyZhipuModel(modelName, type) {
  if (type === 'text') {
    const el = document.getElementById('cfg-zhipu-model');
    if (el) {
      el.value = modelName;
      el.style.borderColor = '#8b5cf6';
      setTimeout(() => el.style.borderColor = '', 1000);
    }
  } else if (type === 'vision') {
    const el = document.getElementById('cfg-zhipu-vision-model');
    if (el) {
      el.value = modelName;
      el.style.borderColor = '#06b6d4';
      setTimeout(() => el.style.borderColor = '', 1000);
    }
  } else if (type === 'embedding') {
    const el = document.getElementById('cfg-zhipu-embedding-model');
    if (el) {
      el.value = modelName;
      el.style.borderColor = '#10b981';
      setTimeout(() => el.style.borderColor = '', 1000);
    }
  }
}
window.applyZhipuModel = applyZhipuModel;


function onTtsProviderChange() {
  updateConfigUiState();
}
window.onTtsProviderChange = onTtsProviderChange;

function switchConfigStep(step) {
  const tab1 = document.getElementById('cfg-tab-1');
  const tab2 = document.getElementById('cfg-tab-2');
  const step1Content = document.getElementById('cfg-step-1-content');
  const step2Content = document.getElementById('cfg-step-2-content');

  if (!tab1 || !tab2 || !step1Content || !step2Content) return;

  if (step === 1) {
    tab1.classList.add('active');
    tab2.classList.remove('active');
    step1Content.classList.remove('hidden');
    step2Content.classList.add('hidden');
  } else {
    tab1.classList.remove('active');
    tab2.classList.add('active');
    step1Content.classList.add('hidden');
    step2Content.classList.remove('hidden');
  }
  updateConfigUiState();
  lucide.createIcons();
}
window.switchConfigStep = switchConfigStep;

function updateConfigUiState() {
  const llmProvider = document.getElementById('cfg-llm-provider')?.value || 'zhipu';
  const embProvider = document.getElementById('cfg-embedding-provider')?.value || 'local';
  const ttsProvider = document.getElementById('cfg-tts-provider')?.value || 'elevenlabs';
  const generateVideo = document.getElementById('cfg-generate-video')?.value === 'true';
  const videoProvider = document.getElementById('cfg-video-provider')?.value || 'elevenlabs';

  const zhipuKey = (document.getElementById('cfg-zhipu-key')?.value || '').trim();
  const openRouterKey = (document.getElementById('cfg-openrouter-key')?.value || '').trim();
  const elevenlabsKey = (document.getElementById('cfg-elevenlabs-key')?.value || '').trim();
  const minimaxKey = (document.getElementById('cfg-minimax-key')?.value || '').trim();
  const minimaxGroup = (document.getElementById('cfg-minimax-group')?.value || '').trim();
  const heygenKey = (document.getElementById('cfg-heygen-key')?.value || '').trim();

  let missingCount = 0;

  // 1. Evaluate LLM Status
  const chkLlmDot = document.getElementById('chk-llm-dot');
  const chkLlmTitle = document.getElementById('chk-llm-title');
  const chkLlmDesc = document.getElementById('chk-llm-desc');
  const cardDynZhipu = document.getElementById('card-dyn-zhipu');
  const badgeDynZhipu = document.getElementById('badge-dyn-zhipu');
  const cardDynOpenRouter = document.getElementById('card-dyn-openrouter');
  const badgeDynOpenRouter = document.getElementById('badge-dyn-openrouter');
  const cardDynVllm = document.getElementById('card-dyn-vllm');

  if (chkLlmTitle && chkLlmDot && chkLlmDesc) {
    if (llmProvider === 'zhipu' || llmProvider === 'glm') {
      chkLlmTitle.textContent = 'LLM: GLM-5.3 (Z.ai PaaS)';
      const isReady = zhipuKey && zhipuKey !== 'mock-zhipu-key';
      if (isReady) {
        chkLlmDot.className = 'cfg-checklist-dot cfg-dot-green';
        chkLlmDesc.textContent = 'Bereit (Key eingetragen)';
        if (badgeDynZhipu) {
          badgeDynZhipu.innerHTML = '<i class="inline-icon" data-lucide="check-circle" style="width:12px;height:12px;color:#10b981;"></i> Bereit';
          badgeDynZhipu.style.background = 'rgba(16,185,129,0.12)';
          badgeDynZhipu.style.color = '#10b981';
        }
      } else {
        chkLlmDot.className = 'cfg-checklist-dot cfg-dot-red';
        chkLlmDesc.textContent = 'Key fehlt -> In Schritt 2 eintragen';
        if (badgeDynZhipu) {
          badgeDynZhipu.innerHTML = '<i class="inline-icon" data-lucide="alert-circle" style="width:12px;height:12px;color:#ef4444;"></i> Key fehlt!';
          badgeDynZhipu.style.background = 'rgba(239,68,68,0.15)';
          badgeDynZhipu.style.color = '#ef4444';
        }
        missingCount++;
      }
    } else if (llmProvider === 'openrouter' || llmProvider === 'gemini') {
      chkLlmTitle.textContent = 'LLM: Gemini 2.5 Pro (OpenRouter)';
      const isReady = openRouterKey && openRouterKey !== 'mock-openrouter-key';
      if (isReady) {
        chkLlmDot.className = 'cfg-checklist-dot cfg-dot-green';
        chkLlmDesc.textContent = 'Bereit (Key eingetragen)';
        if (badgeDynOpenRouter) {
          badgeDynOpenRouter.innerHTML = '<i class="inline-icon" data-lucide="check-circle" style="width:12px;height:12px;color:#10b981;"></i> Bereit';
          badgeDynOpenRouter.style.background = 'rgba(16,185,129,0.12)';
          badgeDynOpenRouter.style.color = '#10b981';
        }
      } else {
        chkLlmDot.className = 'cfg-checklist-dot cfg-dot-red';
        chkLlmDesc.textContent = 'Key fehlt -> In Schritt 2 eintragen';
        if (badgeDynOpenRouter) {
          badgeDynOpenRouter.innerHTML = '<i class="inline-icon" data-lucide="alert-circle" style="width:12px;height:12px;color:#ef4444;"></i> Key fehlt!';
          badgeDynOpenRouter.style.background = 'rgba(239,68,68,0.15)';
          badgeDynOpenRouter.style.color = '#ef4444';
        }
        missingCount++;
      }
    } else {
      chkLlmTitle.textContent = 'LLM: Lokales vLLM';
      chkLlmDot.className = 'cfg-checklist-dot cfg-dot-green';
      chkLlmDesc.textContent = 'Self-Hosted Server aktiv';
    }
  }

  // 2. Evaluate Embedding Status
  const chkEmbDot = document.getElementById('chk-emb-dot');
  const chkEmbTitle = document.getElementById('chk-emb-title');
  const chkEmbDesc = document.getElementById('chk-emb-desc');

  if (chkEmbTitle && chkEmbDot && chkEmbDesc) {
    if (embProvider === 'local') {
      chkEmbTitle.textContent = 'Embeddings: Lokales Modell (MiniLM)';
      chkEmbDot.className = 'cfg-checklist-dot cfg-dot-green';
      chkEmbDesc.textContent = 'Kostenlos & Offline (Kein Key nötig)';
    } else if (embProvider === 'zhipu') {
      chkEmbTitle.textContent = 'Embeddings: z.ai (embedding-3)';
      const isReady = zhipuKey && zhipuKey !== 'mock-zhipu-key';
      if (isReady) {
        chkEmbDot.className = 'cfg-checklist-dot cfg-dot-green';
        chkEmbDesc.textContent = 'Bereit (z.ai Key aktiv)';
      } else {
        chkEmbDot.className = 'cfg-checklist-dot cfg-dot-red';
        chkEmbDesc.textContent = 'z.ai Key fehlt -> In Schritt 2 eintragen';
        if (llmProvider !== 'zhipu') missingCount++;
      }
    } else {
      chkEmbTitle.textContent = 'Embeddings: OpenRouter (OpenAI)';
      const isReady = openRouterKey && openRouterKey !== 'mock-openrouter-key';
      if (isReady) {
        chkEmbDot.className = 'cfg-checklist-dot cfg-dot-green';
        chkEmbDesc.textContent = 'Bereit (OpenRouter Key aktiv)';
      } else {
        chkEmbDot.className = 'cfg-checklist-dot cfg-dot-red';
        chkEmbDesc.textContent = 'OpenRouter Key fehlt';
        if (llmProvider !== 'openrouter') missingCount++;
      }
    }
  }

  // 3. Evaluate TTS Status
  const chkTtsDot = document.getElementById('chk-tts-dot');
  const chkTtsTitle = document.getElementById('chk-tts-title');
  const chkTtsDesc = document.getElementById('chk-tts-desc');
  const cardDynElevenlabs = document.getElementById('card-dyn-elevenlabs');
  const badgeDynElevenlabs = document.getElementById('badge-dyn-elevenlabs');
  const cardDynMinimax = document.getElementById('card-dyn-minimax');
  const badgeDynMinimax = document.getElementById('badge-dyn-minimax');

  if (chkTtsTitle && chkTtsDot && chkTtsDesc) {
    if (ttsProvider === 'elevenlabs') {
      chkTtsTitle.textContent = 'TTS: ElevenLabs';
      const isReady = elevenlabsKey && elevenlabsKey !== 'mock-elevenlabs-key';
      if (isReady) {
        chkTtsDot.className = 'cfg-checklist-dot cfg-dot-green';
        chkTtsDesc.textContent = 'Bereit (Key vorhanden)';
        if (badgeDynElevenlabs) {
          badgeDynElevenlabs.innerHTML = '<i class="inline-icon" data-lucide="check-circle" style="width:12px;height:12px;color:#10b981;"></i> Bereit';
          badgeDynElevenlabs.style.background = 'rgba(16,185,129,0.12)';
          badgeDynElevenlabs.style.color = '#10b981';
        }
      } else {
        chkTtsDot.className = 'cfg-checklist-dot cfg-dot-red';
        chkTtsDesc.textContent = 'Key fehlt -> In Schritt 2 eintragen';
        if (badgeDynElevenlabs) {
          badgeDynElevenlabs.innerHTML = '<i class="inline-icon" data-lucide="alert-circle" style="width:12px;height:12px;color:#ef4444;"></i> Key fehlt!';
          badgeDynElevenlabs.style.background = 'rgba(239,68,68,0.15)';
          badgeDynElevenlabs.style.color = '#ef4444';
        }
        missingCount++;
      }
    } else {
      chkTtsTitle.textContent = 'TTS: MiniMax';
      const isReady = minimaxKey && minimaxGroup && minimaxKey !== 'mock-minimax-key';
      if (isReady) {
        chkTtsDot.className = 'cfg-checklist-dot cfg-dot-green';
        chkTtsDesc.textContent = 'Bereit (Key & Group ID vorhanden)';
        if (badgeDynMinimax) {
          badgeDynMinimax.innerHTML = '<i class="inline-icon" data-lucide="check-circle" style="width:12px;height:12px;color:#10b981;"></i> Bereit';
          badgeDynMinimax.style.background = 'rgba(16,185,129,0.12)';
          badgeDynMinimax.style.color = '#10b981';
        }
      } else {
        chkTtsDot.className = 'cfg-checklist-dot cfg-dot-red';
        chkTtsDesc.textContent = 'Key oder Group ID fehlt';
        if (badgeDynMinimax) {
          badgeDynMinimax.innerHTML = '<i class="inline-icon" data-lucide="alert-circle" style="width:12px;height:12px;color:#ef4444;"></i> Key / Group ID fehlt!';
          badgeDynMinimax.style.background = 'rgba(239,68,68,0.15)';
          badgeDynMinimax.style.color = '#ef4444';
        }
        missingCount++;
      }
    }
  }

  // 4. Evaluate Video Status
  const chkVideoDot = document.getElementById('chk-video-dot');
  const chkVideoTitle = document.getElementById('chk-video-title');
  const chkVideoDesc = document.getElementById('chk-video-desc');
  const cardDynHeygen = document.getElementById('card-dyn-heygen');

  if (chkVideoTitle && chkVideoDot && chkVideoDesc) {
    if (!generateVideo) {
      chkVideoTitle.textContent = 'Video: Nur Ton (Audio-only / MP4)';
      chkVideoDot.className = 'cfg-checklist-dot cfg-dot-green';
      chkVideoDesc.textContent = 'Schnell & Kostenlos (FFmpeg)';
    } else if (videoProvider === 'heygen') {
      chkVideoTitle.textContent = 'Video: HeyGen Avatar';
      const isReady = heygenKey && heygenKey !== 'mock-heygen-key';
      if (isReady) {
        chkVideoDot.className = 'cfg-checklist-dot cfg-dot-green';
        chkVideoDesc.textContent = 'Bereit (HeyGen Key aktiv)';
      } else {
        chkVideoDot.className = 'cfg-checklist-dot cfg-dot-red';
        chkVideoDesc.textContent = 'HeyGen Key fehlt -> In Schritt 2 eintragen';
        missingCount++;
      }
    } else {
      chkVideoTitle.textContent = 'Video: ElevenLabs Lip-Sync';
      chkVideoDot.className = 'cfg-checklist-dot cfg-dot-green';
      chkVideoDesc.textContent = 'Nutzt TTS-Audiomodus';
    }
  }

  // Dynamic Step 2 Card Visibility
  if (cardDynZhipu) {
    cardDynZhipu.style.display = (llmProvider === 'zhipu' || llmProvider === 'glm' || embProvider === 'zhipu' || embProvider === 'glm') ? 'block' : 'none';
  }
  if (cardDynOpenRouter) {
    cardDynOpenRouter.style.display = (llmProvider === 'openrouter' || llmProvider === 'gemini' || embProvider === 'openrouter') ? 'block' : 'none';
  }
  if (cardDynVllm) {
    cardDynVllm.style.display = (llmProvider === 'vllm') ? 'block' : 'none';
  }
  if (cardDynElevenlabs) {
    cardDynElevenlabs.style.display = (ttsProvider === 'elevenlabs' || (generateVideo && videoProvider === 'elevenlabs')) ? 'block' : 'none';
  }
  if (cardDynMinimax) {
    cardDynMinimax.style.display = (ttsProvider === 'minimax') ? 'block' : 'none';
  }
  if (cardDynHeygen) {
    cardDynHeygen.style.display = (generateVideo && videoProvider === 'heygen') ? 'block' : 'none';
  }

  // Overall Status Badges
  const overallBadge = document.getElementById('cfg-overall-status-text');
  const step2Badge = document.getElementById('cfg-badge-step2');

  if (missingCount === 0) {
    if (overallBadge) {
      overallBadge.textContent = 'Alles Bereit ✓';
      overallBadge.style.background = 'rgba(16,185,129,0.15)';
      overallBadge.style.color = '#10b981';
    }
    if (step2Badge) {
      step2Badge.textContent = 'Bereit ✓';
      step2Badge.style.background = 'rgba(16,185,129,0.15)';
      step2Badge.style.color = '#10b981';
    }
  } else {
    if (overallBadge) {
      overallBadge.textContent = `${missingCount} Key(s) erforderlich`;
      overallBadge.style.background = 'rgba(239,68,68,0.15)';
      overallBadge.style.color = '#ef4444';
    }
    if (step2Badge) {
      step2Badge.textContent = `${missingCount} Key(s) fehlt!`;
      step2Badge.style.background = 'rgba(239,68,68,0.15)';
      step2Badge.style.color = '#ef4444';
    }
  }

  lucide.createIcons();
}
window.updateConfigUiState = updateConfigUiState;


async function loadUsageStats() {
  const orEl = document.getElementById('stat-openrouter-usage');
  const orTitle = document.getElementById('stat-llm-title');
  const elEl = document.getElementById('stat-elevenlabs-usage');
  const mmEl = document.getElementById('stat-minimax-usage');
  if (!orEl || !elEl) return;

  try {
    const data = await apiCall('/admin/usage');
    if (data.provider === 'zhipu' || data.provider === 'zai') {
      if (orTitle) orTitle.textContent = 'Z.AI Flatrate Plan';
      if (data.zhipu) {
        orEl.innerHTML = `${data.zhipu.usage} <span style="font-size: 0.75rem; font-weight: normal; color: var(--accent-secondary);">(${data.zhipu.model})</span>`;
      } else {
        orEl.textContent = 'Aktiv';
      }
    } else {
      if (orTitle) orTitle.textContent = 'OpenRouter Kosten';
      orEl.textContent = data.openrouter?.usage || 'Nicht konfiguriert';
      if (data.openrouter?.label) {
        orEl.innerHTML = `${data.openrouter.usage} <span style="font-size: 0.75rem; font-weight: normal; color: var(--text-secondary);">(${data.openrouter.label})</span>`;
      }
    }
    elEl.textContent = data.elevenlabs?.usage || 'Nicht konfiguriert';
    if (mmEl) {
      mmEl.textContent = data.minimax ? data.minimax.usage : 'Nicht konfiguriert';
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

function getDurationHumanLabel(dur) {
  const map = {
    '1_slide': 'Minikurs (1 Folie – Schnelltest)',
    '1slide': 'Minikurs (1 Folie – Schnelltest)',
    '1_day': '1-tägigen (8 UE Testkurs)',
    '1day': '1-tägigen (8 UE Testkurs)',
    '1_week': '1-wöchigen (40 UE)',
    '1week': '1-wöchigen (40 UE)',
    '2_weeks': '2-wöchigen (80 UE)',
    '2weeks': '2-wöchigen (80 UE)',
    '4_weeks': '4-wöchigen / 1-monatigen (160 UE)',
    '4weeks': '4-wöchigen / 1-monatigen (160 UE)',
    '6_weeks': '6-wöchigen (240 UE)',
    '6weeks': '6-wöchigen (240 UE)',
    '8_weeks': '2-monatigen / 8-wöchigen (320 UE Bootcamp)',
    '8weeks': '2-monatigen / 8-wöchigen (320 UE Bootcamp)',
    '1_hour': '1-stündigen Minikurs'
  };
  if (map[dur]) return map[dur];
  if (dur && /^\d+_weeks$/.test(dur)) {
    const w = parseInt(dur.replace('_weeks', ''), 10);
    return `${w}-wöchigen (${w * 40} UE)`;
  }
  return dur || '2-monatigen / 8-wöchigen (320 UE Bootcamp)';
}

async function openWizard(courseId, topic = '', duration = '1_day', mode = 'full') {
  wizardState.courseId = courseId;
  wizardState.currentStep = 1;
  wizardState.topic = topic;
  wizardState.duration = duration || '1_day';
  wizardState.mode = mode || 'full';
  wizardState.curriculumData = null;
  wizardState.activeLessonId = null;

  // Show modal
  const modal = document.getElementById('wizard-modal');
  modal.classList.remove('hidden');

  // Fill in default curriculum prompt
  const isOneSlide = wizardState.duration === '1_slide' || wizardState.duration === '1slide';
  if (isOneSlide) {
    document.getElementById('wz-prompt-step1').value = `Erstelle einen ultrakompakten Minikurs mit genau einer einzigen Folie zum Thema "${topic}".`;
  } else {
    const initialLabel = getDurationHumanLabel(wizardState.duration);
    document.getElementById('wz-prompt-step1').value = `Erstelle einen didaktischen Lehrplan für einen ${initialLabel} zum Thema "${topic}".`;
  }

  // Fetch existing course status to see if it's already in step 1 or step 2 draft
  try {
    const courseDetails = await apiCall(`/courses/${courseId}`);
    wizardState.curriculumData = courseDetails;
    wizardState.topic = courseDetails.course.topic || topic;
    // courses table has no duration column — keep the value from openWizard()/form
    const savedDuration = courseDetails.course?.progress?.duration;
    wizardState.duration = savedDuration || duration || '1_day';
    const savedMode = courseDetails.course?.progress?.mode;
    wizardState.mode = mode || savedMode || 'full';

    // Update prompt with the fetched topic and duration
    const finalOneSlide = wizardState.duration === '1_slide' || wizardState.duration === '1slide';
    if (finalOneSlide) {
      document.getElementById('wz-prompt-step1').value = `Erstelle einen ultrakompakten Minikurs mit genau einer einzigen Folie zum Thema "${wizardState.topic}".`;
    } else {
      const finalLabel = getDurationHumanLabel(wizardState.duration);
      document.getElementById('wz-prompt-step1').value = `Erstelle einen didaktischen Lehrplan für einen ${finalLabel} zum Thema "${wizardState.topic}".`;
    }

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
  const nextBtn = document.getElementById('wz-btn-next');
  if (!btn || !progressBox) return;

  const status = details?.course?.status;
  const prog = details?.course?.progress || {};

  if (status === 'failed') {
    if (wizardState.pollInterval) {
      clearInterval(wizardState.pollInterval);
      wizardState.pollInterval = null;
    }
    progressBox.classList.remove('hidden');
    document.getElementById('wz-progress-step-text').textContent = prog.step || 'Generierung fehlgeschlagen.';
    document.getElementById('wz-progress-step-percent').textContent = 'Fehler';
    document.getElementById('wz-progress-step-bar').style.width = '100%';
    document.getElementById('wz-progress-step-bar').style.backgroundColor = 'var(--accent-error)';
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="refresh-cw"></i> Lektionsinhalte (re)generieren';
    if (nextBtn && wizardState.currentStep === 2) {
      nextBtn.disabled = true;
      nextBtn.style.opacity = '0.5';
    }
    lucide.createIcons();
    return;
  }

  const done = (status === 'content_draft' || status === 'pending_approval' || status === 'active'
    || (prog.percent >= 80 && status !== 'generating' && status !== 'failed')
    || (prog.step && /generiert/i.test(prog.step)))
    && status !== 'failed';

  if (done) {
    wizardState.isGeneratingContent = false;
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
    if (nextBtn && wizardState.currentStep === 2) {
      nextBtn.disabled = false;
      nextBtn.style.opacity = '1';
      nextBtn.style.cursor = 'pointer';
    }
    lucide.createIcons();
    wizardState.curriculumData = details;
    renderStep2Content();
  } else if (status === 'generating') {
    wizardState.isGeneratingContent = true;
    // Resume polling if generation is still running in the background
    progressBox.classList.remove('hidden');
    document.getElementById('wz-progress-step-text').textContent = prog.step || 'Generiere Lektionsinhalte...';
    document.getElementById('wz-progress-step-percent').textContent = `${prog.percent || 0}%`;
    document.getElementById('wz-progress-step-bar').style.width = `${prog.percent || 0}%`;
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="refresh-cw" class="spin"></i> Generiere Inhalte...';
    if (nextBtn && wizardState.currentStep === 2) {
      nextBtn.disabled = true;
      nextBtn.style.opacity = '0.5';
      nextBtn.style.cursor = 'not-allowed';
    }
    lucide.createIcons();
    startStep2ProgressPolling();
  } else {
    wizardState.isGeneratingContent = false;
    progressBox.classList.add('hidden');
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="refresh-cw"></i> Lektionsinhalte (re)generieren';
    if (nextBtn && wizardState.currentStep === 2) {
      nextBtn.disabled = false;
      nextBtn.style.opacity = '1';
      nextBtn.style.cursor = 'pointer';
    }
    lucide.createIcons();
  }
}

function startStep2ProgressPolling() {
  const btn = document.getElementById('wz-btn-regen-step2');
  const nextBtn = document.getElementById('wz-btn-next');
  const progressBox = document.getElementById('wz-step2-progress-box');
  if (wizardState.pollInterval) clearInterval(wizardState.pollInterval);

  if (nextBtn) {
    nextBtn.disabled = true;
    nextBtn.style.opacity = '0.5';
    nextBtn.style.cursor = 'not-allowed';
  }

  wizardState.pollInterval = setInterval(async () => {
    try {
      const details = await apiCall(`/courses/${wizardState.courseId}`);
      const prog = details.course.progress || { percent: 25, step: 'Generiere Lektionsinhalte...' };

      document.getElementById('wz-progress-step-text').textContent = prog.step;
      document.getElementById('wz-progress-step-percent').textContent = `${prog.percent}%`;
      document.getElementById('wz-progress-step-bar').style.width = `${prog.percent}%`;

      // Live update lesson data in state so already generated lessons can be clicked
      if (details.lessons && details.lessons.length > 0) {
        wizardState.curriculumData = details;
        if (wizardState.activeLessonId) {
          const curActive = details.lessons.find(l => l.id === wizardState.activeLessonId);
          const editScript = document.getElementById('wz-les-script-edit');
          if (curActive && curActive.contentPayload?.teleprompter_script && editScript && !editScript.value.trim()) {
            wizardSelectLessonForEdit(wizardState.activeLessonId);
          }
        }
      }

      // Check for failure first before checking done or percentage (Befund 25)
      if (details.course.status === 'failed') {
        wizardState.isGeneratingContent = false;
        clearInterval(wizardState.pollInterval);
        wizardState.pollInterval = null;
        alert('Die Generierung ist fehlgeschlagen: ' + (prog.step || 'Unbekannter Fehler'));
        progressBox.classList.remove('hidden');
        document.getElementById('wz-progress-step-text').textContent = prog.step || 'Fehler aufgetreten.';
        document.getElementById('wz-progress-step-percent').textContent = 'Fehler';
        document.getElementById('wz-progress-step-bar').style.width = '100%';
        document.getElementById('wz-progress-step-bar').style.backgroundColor = 'var(--accent-error)';
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="refresh-cw"></i> Lektionsinhalte (re)generieren';
        lucide.createIcons();
        return;
      }

      const status = details.course.status;
      const done = (status === 'content_draft'
        || status === 'pending_approval'
        || status === 'active'
        || (prog.percent >= 80 && status !== 'generating' && status !== 'failed')
        || (prog.step && /generiert/i.test(prog.step)))
        && status !== 'failed';

      if (done) {
        wizardState.isGeneratingContent = false;
        clearInterval(wizardState.pollInterval);
        wizardState.pollInterval = null;
        syncWizardStep2Ui(details);
        return;
      }
    } catch (pollErr) {
      console.error('Error polling content generation progress:', pollErr);
      // Stop polling on auth/session errors so the UI doesn't stay stuck forever
      if (String(pollErr.message || '').includes('Sitzung abgelaufen')) {
        wizardState.isGeneratingContent = false;
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
  wizardState.isGeneratingContent = false;
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
    const hasAnyContent = wizardState.curriculumData?.lessons?.some(l => l.contentPayload?.teleprompter_script || l.contentPayload?.text_content);
    if (!hasAnyContent) {
      if (nextBtn) {
        nextBtn.disabled = true;
        nextBtn.style.opacity = '0.5';
        nextBtn.style.cursor = 'not-allowed';
      }
      wizardGenerateLessonsContent();
    }
  }

  const finishConceptBtn = document.getElementById('wz-btn-finish-concept');
  if (finishConceptBtn) {
    if (step === 1 && wizardState.mode === 'concept') {
      finishConceptBtn.classList.remove('hidden');
    } else {
      finishConceptBtn.classList.add('hidden');
    }
  }

  lucide.createIcons();
}

async function finishConceptOnly() {
  if (!wizardState.courseId) return;
  const finishBtn = document.getElementById('wz-btn-finish-concept');
  if (finishBtn) {
    finishBtn.disabled = true;
    finishBtn.innerHTML = '<i data-lucide="loader-2" class="spin"></i> Speichere Konzept…';
    lucide.createIcons();
  }

  try {
    await new Promise((resolve) => {
      wizardSaveStep1(async () => {
        try {
          await apiCall(`/courses/${wizardState.courseId}/finish-concept`, { method: 'POST' });
          resolve(true);
        } catch (err) {
          console.error('Error in finish-concept API call:', err);
          resolve(false);
        }
      });
    });

    alert('Didaktisches Konzept erfolgreich gespeichert! Der Kurs ist im Dashboard als Rahmenlehrplan hinterlegt.');
    closeWizard();
    loadAdminDashboard();
  } catch (err) {
    alert('Fehler beim Speichern des Konzepts: ' + err.message);
  } finally {
    if (finishBtn) {
      finishBtn.disabled = false;
      finishBtn.innerHTML = '<i data-lucide="check"></i> Konzept speichern & abschließen';
      lucide.createIcons();
    }
  }
}
window.finishConceptOnly = finishConceptOnly;

function wizardNextStep() {
  if (wizardState.currentStep === 1) {
    // Save current step 1 state to DB before proceeding
    wizardSaveStep1(() => goToWizardStep(2));
  } else if (wizardState.currentStep === 2) {
    const step2Btn = document.getElementById('wz-btn-regen-step2');
    if (step2Btn && step2Btn.disabled) {
      alert('Bitte warte kurz, bis die Lektionsinhalte und Sprechskripte fertig generiert sind.');
      return;
    }
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
  const nextBtn = document.getElementById('wz-btn-next');
  const editor = document.getElementById('wz-curriculum-editor');
  const prompt = document.getElementById('wz-prompt-step1').value;
  const progressBox = document.getElementById('wz-step1-progress-box');
  const progressText = document.getElementById('wz-step1-progress-text');
  const progressPercent = document.getElementById('wz-step1-progress-percent');
  const progressBar = document.getElementById('wz-step1-progress-bar');

  if (btn.dataset.busy === '1') return;
  btn.dataset.busy = '1';
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="refresh-cw" class="spin"></i> Generiere Lehrplan…';

  // Disable Weiter button while generating
  if (nextBtn) {
    nextBtn.disabled = true;
    nextBtn.style.opacity = '0.5';
    nextBtn.style.cursor = 'not-allowed';
    nextBtn.title = 'Generierung läuft...';
  }

  // Show progress box
  if (progressBox) progressBox.classList.remove('hidden');

  let currentPercent = 12;
  const updateProgress = (pct, text) => {
    currentPercent = pct;
    if (progressPercent) progressPercent.textContent = `${pct}%`;
    if (progressBar) progressBar.style.width = `${pct}%`;
    if (progressText) {
      progressText.innerHTML = `
        <i data-lucide="loader-2" class="spin" style="width: 15px; height: 15px; color: #c084fc;"></i>
        <span>${text}</span>
      `;
      lucide.createIcons();
    }
  };

  updateProgress(12, '1/4 Thema & didaktische Struktur analysieren...');

  let progressStage = 0;
  const progressTimer = setInterval(() => {
    progressStage++;
    if (progressStage === 3) {
      updateProgress(35, '2/4 Module & Lerneinheiten konzipieren...');
    } else if (progressStage === 8) {
      updateProgress(65, '3/4 Präsentationsfolien & Kernpunkte formulieren...');
    } else if (progressStage === 15) {
      updateProgress(85, '4/4 Vollständigkeit prüfen & Lehrplan strukturieren...');
    } else if (progressStage > 15 && currentPercent < 94) {
      updateProgress(Math.min(94, currentPercent + 1), '4/4 KI schließt Lehrplan-Generierung ab...');
    }
  }, 1500);

  if (editor) {
    editor.innerHTML = `
      <div style="text-align:center; padding:28px 16px; color:var(--text-secondary);">
        <i data-lucide="loader-2" class="spin" style="width:28px;height:28px;margin-bottom:12px;color:var(--accent-primary);"></i>
        <p style="margin:0 0 6px; color:#fff; font-weight:600;">Lehrplan wird mit der KI generiert…</p>
        <p style="margin:0; font-size:0.85rem;">Das KI-Modell formuliert den Lehrplan und die Folienstruktur.</p>
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

    clearInterval(progressTimer);
    if (progressPercent) progressPercent.textContent = '100%';
    if (progressBar) progressBar.style.width = '100%';
    if (progressText) {
      progressText.innerHTML = `
        <i data-lucide="check-circle-2" style="width: 15px; height: 15px; color: #10b981;"></i>
        <span style="color: #10b981; font-weight: 600;">Lehrplan erfolgreich generiert!</span>
      `;
      lucide.createIcons();
    }

    // Fetch updated details from DB
    const courseDetails = await apiCall(`/courses/${wizardState.courseId}`);
    wizardState.curriculumData = courseDetails;
    renderStep1Curriculum();
  } catch (err) {
    clearInterval(progressTimer);
    if (progressBox) progressBox.classList.add('hidden');
    if (editor) {
      editor.innerHTML = `<p style="color:#ef4444; text-align:center; padding:20px;">Fehler: ${err.message}</p>`;
    }
    alert('Fehler beim Generieren des Lehrplans: ' + err.message);
  } finally {
    clearInterval(progressTimer);
    btn.dataset.busy = '0';
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="refresh-cw"></i> Curriculum regenerieren';
    lucide.createIcons();
  }
}

function renderStep1Curriculum() {
  const container = document.getElementById('wz-curriculum-editor');
  const nextBtn = document.getElementById('wz-btn-next');
  container.innerHTML = '';

  if (!wizardState.curriculumData || !wizardState.curriculumData.modules || wizardState.curriculumData.modules.length === 0) {
    container.innerHTML = '<p style="color: var(--text-secondary); text-align: center; padding: 20px;">Noch kein Lehrplan generiert. Klicke oben auf "Curriculum regenerieren".</p>';
    if (nextBtn && wizardState.currentStep === 1) {
      nextBtn.disabled = true;
      nextBtn.style.opacity = '0.5';
      nextBtn.style.cursor = 'not-allowed';
      nextBtn.title = 'Bitte zuerst einen Lehrplan generieren';
    }
    return;
  }

  // Enable Weiter button when curriculum is ready
  if (nextBtn && wizardState.currentStep === 1) {
    nextBtn.disabled = false;
    nextBtn.style.opacity = '1';
    nextBtn.style.cursor = 'pointer';
    nextBtn.title = '';
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
        <input type="text" class="wz-mod-title-input" data-mod-id="${mod.id}" value="${escapeHtml(mod.title)}" style="font-weight: bold; font-size: 1.05rem; background: rgba(0,0,0,0.15); border: 1px solid rgba(255,255,255,0.08); padding: 6px 10px; border-radius: 4px; color: #fff; width: 100%;">
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
            <input type="text" class="wz-slide-title-input" data-lesson-id="${les.id}" data-slide-index="${sIdx}" value="${escapeHtml(slide.title)}" placeholder="Titel der Folie" style="font-size: 0.85rem; padding: 4px 8px; margin-bottom: 4px; width: 100%; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.08); border-radius: 4px; color: #fff;">
            <textarea class="wz-slide-bullets-input" data-lesson-id="${les.id}" data-slide-index="${sIdx}" placeholder="Stichpunkte (jeder Stichpunkt in eine neue Zeile)" style="font-size: 0.8rem; padding: 4px 8px; width: 100%; height: 60px; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.08); border-radius: 4px; color: #fff; resize: vertical; font-family: inherit;">${escapeHtml((slide.bullets || []).join('\n'))}</textarea>
          </div>
        `;
      });

      lesCard.innerHTML = `
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 8px;">
          <div class="form-group" style="margin-bottom:0;">
            <label style="font-size: 0.7rem; color: var(--text-secondary);">Lektion ${lesIdx + 1} Titel</label>
            <input type="text" class="wz-les-title-input" data-les-id="${les.id}" value="${escapeHtml(les.title)}" style="background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.08); padding: 4px 8px; border-radius: 4px; color: #fff; width: 100%; font-size: 0.9rem;">
          </div>
          <div class="form-group" style="margin-bottom:0;">
            <label style="font-size: 0.7rem; color: var(--text-secondary);">Lernzeit (Minuten)</label>
            <input type="number" class="wz-les-duration-input" data-les-id="${les.id}" value="${payload.estimated_duration_minutes || 15}" style="background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.08); padding: 4px 8px; border-radius: 4px; color: #fff; width: 100%; font-size: 0.9rem;">
          </div>
        </div>
        <div class="form-group" style="margin-bottom:8px;">
          <label style="font-size: 0.7rem; color: var(--text-secondary);">Kurzbeschreibung</label>
          <input type="text" class="wz-les-desc-input" data-les-id="${les.id}" value="${escapeHtml(payload.description || '')}" style="background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.08); padding: 4px 8px; border-radius: 4px; color: #fff; width: 100%; font-size: 0.85rem;">
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
  if (wizardState.isGeneratingContent) return;
  wizardState.isGeneratingContent = true;

  const btn = document.getElementById('wz-btn-regen-step2');
  const nextBtn = document.getElementById('wz-btn-next');
  const prompt = document.getElementById('wz-prompt-step2').value;
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="refresh-cw" class="spin"></i> Generiere Inhalte...';
  if (nextBtn) {
    nextBtn.disabled = true;
    nextBtn.style.opacity = '0.5';
    nextBtn.style.cursor = 'not-allowed';
  }
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
    wizardState.isGeneratingContent = false;
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
    modGroup.innerHTML = `<h6 style="margin-bottom:4px; font-size: 0.8rem; color: var(--accent-secondary);">${escapeHtml(mod.title)}</h6>`;

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
        <span>${escapeHtml(les.title)}</span>
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
        <input type="text" class="wz-q-question" value="${escapeHtml(q.question)}" placeholder="Frage" style="width: 100%; font-size: 0.8rem; padding: 4px 8px; margin-bottom: 4px; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.08); border-radius: 4px; color: #fff;">
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin-bottom: 4px;">
          <input type="text" class="wz-q-opt" data-opt-idx="0" value="${escapeHtml(q.options[0] || '')}" placeholder="Option A" style="font-size: 0.75rem; padding: 2px 6px; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.08); border-radius: 4px; color: #fff;">
          <input type="text" class="wz-q-opt" data-opt-idx="1" value="${escapeHtml(q.options[1] || '')}" placeholder="Option B" style="font-size: 0.75rem; padding: 2px 6px; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.08); border-radius: 4px; color: #fff;">
          <input type="text" class="wz-q-opt" data-opt-idx="2" value="${escapeHtml(q.options[2] || '')}" placeholder="Option C" style="font-size: 0.75rem; padding: 2px 6px; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.08); border-radius: 4px; color: #fff;">
          <input type="text" class="wz-q-opt" data-opt-idx="3" value="${escapeHtml(q.options[3] || '')}" placeholder="Option D" style="font-size: 0.75rem; padding: 2px 6px; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.08); border-radius: 4px; color: #fff;">
        </div>
        <div style="display: grid; grid-template-columns: 1fr 2fr; gap: 8px; align-items: center;">
          <div>
            <label style="font-size: 0.7rem; color: var(--text-secondary);">Richtige Option Index (0-3)</label>
            <input type="number" class="wz-q-correct" min="0" max="3" value="${typeof q.correct_option_index === 'number' ? q.correct_option_index : 0}" style="width: 50px; font-size: 0.75rem; padding: 2px 6px; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.08); border-radius: 4px; color: #fff;">
          </div>
          <div>
            <label style="font-size: 0.7rem; color: var(--text-secondary);">Erklärung</label>
            <input type="text" class="wz-q-explain" value="${escapeHtml(q.explanation)}" placeholder="Warum richtig?" style="width: 100%; font-size: 0.75rem; padding: 2px 6px; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.08); border-radius: 4px; color: #fff;">
          </div>
        </div>
      </div>
    `;
  });

  panel.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 8px; margin-bottom: 12px;">
      <h4 style="font-size: 0.95rem; color: #fff; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 65%;" title="${escapeHtml(lesson.title)}">"${escapeHtml(lesson.title)}" bearbeiten</h4>
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
  // Pre-validate that all lessons have teleprompter scripts
  const lessons = wizardState.curriculumData?.lessons || [];
  const missing = lessons.filter(l => {
    const payload = l.contentPayload || {};
    const script = (payload.teleprompter_script || '').trim();
    const slideNotes = (payload.slides || []).map(s => (s.speaker_notes || '').trim()).filter(Boolean);
    return script.length < 15 && slideNotes.length === 0;
  });

  if (missing.length > 0) {
    const names = missing.slice(0, 4).map(l => `• ${l.title}`).join('\n');
    const extra = missing.length > 4 ? `\n... und ${missing.length - 4} weitere` : '';
    alert(
      `⚠️ Fehlende Sprechskripte!\n\n` +
      `Für ${missing.length} Lektion(en) wurde noch kein Teleprompter-Sprechskript hinterlegt:\n\n` +
      `${names}${extra}\n\n` +
      `Bitte wechsle zu Schritt 2 ("Inhalte & Skripte") und führe "Lektionsinhalte generieren" aus oder trage die Skripte manuell ein, bevor das Audio-Rendering gestartet werden kann.`
    );
    goToWizardStep(2);
    return;
  }

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
      setTimeout(async () => {
        try {
          if (typeof mermaid !== 'undefined') {
            await mermaid.run({
              nodes: [document.getElementById(`mermaid-svg-${idx}`)]
            });
          }
        } catch (err) {
          console.error('Mermaid render error:', err);
          chartContainer.innerHTML = `<div style="color:var(--accent-error); font-size:0.85rem;">[Diagramm-Fehler: Syntax ungültig]</div><pre style="text-align:left; font-size:0.75rem; color:var(--text-secondary); margin-top:8px; white-space:pre-wrap; word-break:break-all;">${escapeHtml(slide.mermaid_code)}</pre>`;
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

let currentDisplayedSlideImageUrl = '';

function updateSlideStageImage(imageUrl, transition = 'fade') {
  if (!imageUrl || imageUrl === currentDisplayedSlideImageUrl) return;
  currentDisplayedSlideImageUrl = imageUrl;

  const imgEl = document.getElementById('slide-stage-image');
  const imgWrapper = document.getElementById('slide-stage-img-wrapper');
  if (!imgEl || !imgWrapper) return;

  imgWrapper.style.display = 'block';

  // Apply smooth transition effect
  imgEl.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
  imgEl.style.opacity = '0';
  if (transition === 'slide_left') {
    imgEl.style.transform = 'translateX(15px)';
  } else if (transition === 'slide_right') {
    imgEl.style.transform = 'translateX(-15px)';
  } else if (transition === 'zoom_in') {
    imgEl.style.transform = 'scale(0.92)';
  }

  setTimeout(() => {
    imgEl.src = imageUrl;
    imgEl.onload = () => {
      imgEl.style.opacity = '1';
      imgEl.style.transform = 'none';
    };
  }, 140);
}

function syncSlideImageCues(player) {
  const slides = classroomSlideState.slides || [];
  if (slides.length === 0) return;
  const idx = Math.min(classroomSlideState.currentIndex, slides.length - 1);
  const slide = slides[idx];
  const cues = slide.image_cues || [];
  if (!cues || cues.length === 0) return;

  let slidePercent = 0;
  if (classroomSlideState.perSlideAudio) {
    if (player && player.duration && isFinite(player.duration) && player.duration > 0) {
      slidePercent = (player.currentTime / player.duration) * 100;
    }
  } else if (player && player.duration && isFinite(player.duration) && player.duration > 0) {
    const segment = player.duration / slides.length;
    const slideStart = idx * segment;
    slidePercent = Math.max(0, Math.min(100, ((player.currentTime - slideStart) / segment) * 100));
  }

  let activeCue = cues[0];
  for (const cue of cues) {
    if (slidePercent >= (cue.timestamp_percent || 0)) {
      activeCue = cue;
    }
  }

  if (activeCue && activeCue.image_url) {
    updateSlideStageImage(activeCue.image_url, activeCue.transition || 'fade');
  }
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
    syncSlideImageCues(player);
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
          .map(p => `<p style="margin-bottom: 12px; line-height: 1.6; text-align: left;">${escapeHtml(p)}</p>`)
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
      
      setTimeout(async () => {
        try {
          if (typeof mermaid !== 'undefined') {
            await mermaid.run({
              nodes: [document.getElementById(`preview-mermaid-svg-${idx}`)]
            });
          }
        } catch (err) {
          console.error('Mermaid preview render error:', err);
          chartContainer.innerHTML = `<div style="color:var(--accent-error); font-size:0.85rem;">[Diagramm-Fehler: Syntax ungültig]</div><pre style="text-align:left; font-size:0.75rem; color:var(--text-secondary); margin-top:8px; white-space:pre-wrap; word-break:break-all;">${escapeHtml(slide.mermaid_code)}</pre>`;
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
window.playCourseAdmin = playCourseAdmin;
window.exportCourseMp4 = exportCourseMp4;
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
  if (slide.image_cues && Array.isArray(slide.image_cues) && slide.image_cues.length > 0) {
    const firstWithUrl = slide.image_cues.find(c => c.image_url && c.image_url.trim());
    if (firstWithUrl) return firstWithUrl.image_url;
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

// ==================== ADMIN PROMPT TEMPLATES MANAGER ====================
const promptState = {
  prompts: [],
  activePromptId: null,
  activePrompt: null,
  filterCategory: 'all',
  searchTerm: '',
  activeTargetTextarea: 'user', // 'user' or 'system'
  isPreviewOpen: false,
};

function togglePromptsPanel() {
  const content = document.getElementById('prompts-collapse-content');
  const chevron = document.getElementById('prompts-chevron');
  if (!content || !chevron) return;

  const isHidden = content.classList.contains('hidden');
  if (isHidden) {
    content.classList.remove('hidden');
    chevron.style.transform = 'rotate(180deg)';
    if (!promptState.prompts || promptState.prompts.length === 0) {
      loadAdminPrompts();
    }
  } else {
    content.classList.add('hidden');
    chevron.style.transform = 'rotate(0deg)';
  }
}

async function loadAdminPrompts() {
  try {
    const listContainer = document.getElementById('prompts-list-container');
    if (!listContainer) return;

    const prompts = await apiCall('/admin/prompts');
    promptState.prompts = prompts || [];

    // Update count badges
    const totalCountEl = document.getElementById('count-all-prompts');
    const headerCountEl = document.getElementById('prompts-badge-count');
    if (totalCountEl) totalCountEl.textContent = promptState.prompts.length;
    if (headerCountEl) headerCountEl.textContent = `${promptState.prompts.length} Schablonen`;

    renderPromptsList();

    // Select the first prompt if none is selected
    if (promptState.prompts.length > 0) {
      const selectedId = promptState.activePromptId || promptState.prompts[0].id;
      selectAdminPrompt(selectedId);
    }
  } catch (err) {
    console.error('Fehler beim Laden der Prompt-Schablonen:', err);
    const listContainer = document.getElementById('prompts-list-container');
    if (listContainer) {
      listContainer.innerHTML = `<div style="padding: 12px; color: var(--accent-error); font-size: 0.8rem;">Fehler beim Laden: ${err.message}</div>`;
    }
  }
}

function renderPromptsList() {
  const listContainer = document.getElementById('prompts-list-container');
  if (!listContainer) return;

  const filtered = promptState.prompts.filter(p => {
    // Category filter
    if (promptState.filterCategory !== 'all') {
      if (!p.category || !p.category.toLowerCase().includes(promptState.filterCategory.toLowerCase())) {
        return false;
      }
    }
    // Search term
    if (promptState.searchTerm) {
      const q = promptState.searchTerm.toLowerCase();
      const matchTitle = (p.title || '').toLowerCase().includes(q);
      const matchDesc = (p.description || '').toLowerCase().includes(q);
      const matchAgent = (p.target_agent || '').toLowerCase().includes(q);
      if (!matchTitle && !matchDesc && !matchAgent) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    listContainer.innerHTML = '<div style="padding: 16px; text-align: center; color: var(--text-secondary); font-size: 0.8rem;">Keine passenden Schablonen gefunden</div>';
    return;
  }

  listContainer.innerHTML = '';
  filtered.forEach(prompt => {
    const item = document.createElement('div');
    const isActive = prompt.id === promptState.activePromptId;
    item.className = `prompt-list-item ${isActive ? 'active' : ''}`;
    item.onclick = () => selectAdminPrompt(prompt.id);

    const isCustomized = prompt.is_customized;
    const statusBadge = isCustomized
      ? '<span class="badge badge-customized" style="font-size: 10px; padding: 1px 6px;">Individuell</span>'
      : '<span class="badge badge-default" style="font-size: 10px; padding: 1px 6px;">Standard</span>';

    item.innerHTML = `
      <div class="prompt-item-header">
        <span class="prompt-item-title" title="${escapeHtml(prompt.title)}">${escapeHtml(prompt.title)}</span>
        ${statusBadge}
      </div>
      <div class="prompt-item-sub">
        <span style="display: flex; align-items: center; gap: 4px;">
          <i data-lucide="cpu" style="width: 12px; height: 12px; color: var(--accent-primary);"></i>
          ${escapeHtml(prompt.target_agent || prompt.category)}
        </span>
        <span>${(prompt.variables || []).length} Variablen</span>
      </div>
    `;
    listContainer.appendChild(item);
  });

  lucide.createIcons();
}

function filterPromptCategory(category, buttonEl) {
  promptState.filterCategory = category;
  document.querySelectorAll('.prompt-filter-btn').forEach(b => b.classList.remove('active'));
  if (buttonEl) buttonEl.classList.add('active');
  renderPromptsList();
}

function onPromptSearchChange(term) {
  promptState.searchTerm = term.trim();
  renderPromptsList();
}

function selectAdminPrompt(promptId) {
  promptState.activePromptId = promptId;
  const prompt = promptState.prompts.find(p => p.id === promptId);
  if (!prompt) return;

  promptState.activePrompt = prompt;

  // Highlight active in list
  document.querySelectorAll('.prompt-list-item').forEach(el => el.classList.remove('active'));
  renderPromptsList();

  // Populate Meta
  document.getElementById('pe-title').textContent = prompt.title;
  document.getElementById('pe-desc').textContent = prompt.description || '';
  document.getElementById('pe-agent-badge').textContent = prompt.target_agent || prompt.category;
  document.getElementById('pe-model-name').textContent = prompt.recommended_model || 'Standard LLM';

  const statusBadge = document.getElementById('pe-status-badge');
  if (prompt.is_customized) {
    statusBadge.textContent = 'Benutzerdefiniert angepasst';
    statusBadge.className = 'badge badge-customized';
  } else {
    statusBadge.textContent = 'Standard-Vorlage (Unverändert)';
    statusBadge.className = 'badge badge-default';
  }

  // Populate textareas
  const sysArea = document.getElementById('pe-system-prompt');
  const usrArea = document.getElementById('pe-user-prompt');
  sysArea.value = prompt.system_prompt || '';
  usrArea.value = prompt.user_prompt || '';

  updatePromptCharCount('system');
  updatePromptCharCount('user');

  // Populate variables list
  renderVariablesToolbar(prompt.variables || []);

  // Refresh preview if currently open
  if (promptState.isPreviewOpen) {
    refreshPromptPreview();
  }
}

function renderVariablesToolbar(variables) {
  const container = document.getElementById('pe-variables-list');
  if (!container) return;

  if (variables.length === 0) {
    container.innerHTML = '<span style="font-size: 0.75rem; color: var(--text-secondary);">Keine Variablen für diese Schablone deklariert.</span>';
    return;
  }

  container.innerHTML = '';
  variables.forEach(v => {
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'prompt-var-badge';
    badge.title = `${v.desc || v.name} – Klick fügt {${v.name}} an Cursor-Position ein`;
    badge.innerHTML = `<i data-lucide="plus" style="width: 11px; height: 11px;"></i> {${v.name}}`;
    badge.onclick = (e) => {
      e.preventDefault();
      insertPromptVariable(v.name);
    };
    container.appendChild(badge);
  });

  lucide.createIcons();
}

function setActivePromptTextarea(target) {
  promptState.activeTargetTextarea = target;
  const label = document.getElementById('pe-active-target');
  if (label) {
    label.textContent = target === 'system' ? 'System Prompt' : 'User Prompt';
  }
}

function insertPromptVariable(varName) {
  const targetId = promptState.activeTargetTextarea === 'system' ? 'pe-system-prompt' : 'pe-user-prompt';
  const textarea = document.getElementById(targetId);
  if (!textarea) return;

  const placeholder = `{${varName}}`;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const text = textarea.value;

  textarea.value = text.substring(0, start) + placeholder + text.substring(end);
  textarea.focus();
  textarea.selectionStart = textarea.selectionEnd = start + placeholder.length;

  updatePromptCharCount(promptState.activeTargetTextarea);
  showPromptToast(`Variable {${varName}} eingefügt!`, false);
}

function updatePromptCharCount(target) {
  const areaId = target === 'system' ? 'pe-system-prompt' : 'pe-user-prompt';
  const countId = target === 'system' ? 'pe-sys-count' : 'pe-usr-count';
  const area = document.getElementById(areaId);
  const countEl = document.getElementById(countId);
  if (area && countEl) {
    countEl.textContent = `${area.value.length} Zeichen`;
  }
}

async function saveActivePrompt() {
  if (!promptState.activePromptId) return;

  const btn = document.getElementById('btn-save-prompt');
  const sysVal = document.getElementById('pe-system-prompt').value;
  const usrVal = document.getElementById('pe-user-prompt').value;

  if (btn) btn.disabled = true;

  try {
    const res = await apiCall(`/admin/prompts/${promptState.activePromptId}`, {
      method: 'PUT',
      body: JSON.stringify({
        system_prompt: sysVal,
        user_prompt: usrVal,
      }),
    });

    if (res.success) {
      // Update in local state
      const idx = promptState.prompts.findIndex(p => p.id === promptState.activePromptId);
      if (idx !== -1) {
        promptState.prompts[idx] = res.prompt;
      }
      promptState.activePrompt = res.prompt;

      const statusBadge = document.getElementById('pe-status-badge');
      if (res.prompt.is_customized) {
        statusBadge.textContent = 'Benutzerdefiniert angepasst';
        statusBadge.className = 'badge badge-customized';
      } else {
        statusBadge.textContent = 'Standard-Vorlage (Unverändert)';
        statusBadge.className = 'badge badge-default';
      }

      renderPromptsList();
      showPromptToast('Prompt-Schablone erfolgreich gespeichert!', false);

      if (promptState.isPreviewOpen) {
        refreshPromptPreview();
      }
    }
  } catch (err) {
    showPromptToast('Fehler beim Speichern: ' + err.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function resetActivePrompt() {
  if (!promptState.activePromptId) return;

  const ok = confirm('Möchtest du diese Prompt-Vorlage wirklich auf die Werkseinstellungen zurücksetzen? Deine Änderungen gehen dabei verloren.');
  if (!ok) return;

  const btn = document.getElementById('btn-reset-prompt');
  if (btn) btn.disabled = true;

  try {
    const res = await apiCall(`/admin/prompts/${promptState.activePromptId}/reset`, {
      method: 'POST',
    });

    if (res.success) {
      const idx = promptState.prompts.findIndex(p => p.id === promptState.activePromptId);
      if (idx !== -1) {
        promptState.prompts[idx] = res.prompt;
      }
      promptState.activePrompt = res.prompt;

      document.getElementById('pe-system-prompt').value = res.prompt.system_prompt || '';
      document.getElementById('pe-user-prompt').value = res.prompt.user_prompt || '';
      updatePromptCharCount('system');
      updatePromptCharCount('user');

      const statusBadge = document.getElementById('pe-status-badge');
      statusBadge.textContent = 'Standard-Vorlage (Unverändert)';
      statusBadge.className = 'badge badge-default';

      renderPromptsList();
      showPromptToast('Prompt-Schablone erfolgreich auf Standard zurückgesetzt!', false);

      if (promptState.isPreviewOpen) {
        refreshPromptPreview();
      }
    }
  } catch (err) {
    showPromptToast('Fehler beim Zurücksetzen: ' + err.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function togglePromptPreview() {
  const box = document.getElementById('pe-preview-box');
  const btnText = document.getElementById('pe-preview-btn-text');
  if (!box) return;

  promptState.isPreviewOpen = !promptState.isPreviewOpen;
  if (promptState.isPreviewOpen) {
    box.classList.remove('hidden');
    if (btnText) btnText.textContent = 'Vorschau ausblenden';
    refreshPromptPreview();
  } else {
    box.classList.add('hidden');
    if (btnText) btnText.textContent = 'Test-Vorschau anzeigen';
  }
}

async function refreshPromptPreview() {
  if (!promptState.activePromptId) return;

  const previewContent = document.getElementById('pe-preview-content');
  if (!previewContent) return;

  previewContent.textContent = 'Rendere Vorschau mit Test-Variablen...';

  const sysVal = document.getElementById('pe-system-prompt').value;
  const usrVal = document.getElementById('pe-user-prompt').value;

  try {
    const res = await apiCall(`/admin/prompts/${promptState.activePromptId}/preview`, {
      method: 'POST',
      body: JSON.stringify({
        system_prompt: sysVal,
        user_prompt: usrVal,
      }),
    });

    if (res.success) {
      previewContent.textContent = `=== [SYSTEM PROMPT] ===\n${res.rendered_system_prompt}\n\n=== [USER PROMPT (AUFGABENSTELLUNG)] ===\n${res.rendered_user_prompt}`;
    } else {
      previewContent.textContent = 'Fehler beim Rendern der Vorschau: ' + (res.error || 'Unbekannt');
    }
  } catch (err) {
    previewContent.textContent = 'Fehler: ' + err.message;
  }
}

function showPromptToast(message, isError) {
  const toast = document.getElementById('pe-toast');
  if (!toast) return;

  toast.textContent = message;
  toast.style.display = 'block';
  if (isError) {
    toast.style.background = 'rgba(239, 68, 68, 0.2)';
    toast.style.border = '1px solid rgba(239, 68, 68, 0.4)';
    toast.style.color = '#fca5a5';
  } else {
    toast.style.background = 'rgba(16, 185, 129, 0.2)';
    toast.style.border = '1px solid rgba(16, 185, 129, 0.4)';
    toast.style.color = '#6ee7b7';
  }

  setTimeout(() => {
    toast.style.display = 'none';
  }, 4000);
}



