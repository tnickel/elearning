import { app } from '../src/server/app';
import http from 'http';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
}

async function run() {
  console.log('Testing Admin Prompt API Endpoints...');

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as any;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  // The former Host-header/localhost auth bypass was removed (security fix).
  // Obtain a real admin token via the login endpoint instead. If no DB is
  // available, fall back to the explicit opt-in loopback admin bypass.
  let authHeaders: Record<string, string> = {};
  try {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@tenant-alpha.com', role: 'admin' }),
    });
    if (loginRes.ok) {
      const login = await loginRes.json() as any;
      if (login.token && login.user?.role === 'admin') {
        authHeaders = { 'Authorization': `Bearer ${login.token}` };
        console.log('✓ 0. Admin token obtained via /api/auth/login');
      }
    }
  } catch (_) { /* fall through to local-admin mode */ }

  const usingLocalAdminFallback = !authHeaders['Authorization'];
  if (usingLocalAdminFallback) {
    process.env.ALLOW_LOCAL_ADMIN = 'true';
    console.log('i 0. No DB login possible - using ALLOW_LOCAL_ADMIN loopback bypass for this test.');
  }

  try {
    // 1. GET /api/admin/prompts
    const res1 = await fetch(`${baseUrl}/api/admin/prompts`, { headers: authHeaders });
    assert(res1.status === 200, `GET /api/admin/prompts should return 200, got ${res1.status}`);
    const prompts = await res1.json() as any;
    assert(Array.isArray(prompts), 'Response must be an array');
    assert(prompts.length >= 8, `Expected at least 8 prompts, got ${prompts.length}`);
    console.log(`✓ 1. GET /api/admin/prompts returned ${prompts.length} prompt templates`);

    // Unauthenticated access must be rejected (regression for the removed bypass).
    // Skipped when the loopback fallback is active, since loopback IS the bypass.
    if (!usingLocalAdminFallback) {
      const resUnauth = await fetch(`${baseUrl}/api/admin/prompts`);
      assert(resUnauth.status === 401 || resUnauth.status === 403,
        `GET /api/admin/prompts without token must be 401/403, got ${resUnauth.status}`);
      console.log('✓ 1b. Unauthenticated prompt access correctly rejected');
    }

    // Verify properties
    const macro = prompts.find((p: any) => p.id === 'macro_curriculum');
    assert(!!macro, 'macro_curriculum prompt must be in list');
    assert(Array.isArray(macro.variables), 'macro prompt must have variables array');
    assert(typeof macro.system_prompt === 'string', 'macro must have system_prompt');
    assert(typeof macro.user_prompt === 'string', 'macro must have user_prompt');
    console.log('✓ 2. Prompt schema and variables validated');

    // 2. GET single prompt /api/admin/prompts/quiz
    const res2 = await fetch(`${baseUrl}/api/admin/prompts/quiz`, { headers: authHeaders });
    assert(res2.status === 200, `GET /api/admin/prompts/quiz should return 200, got ${res2.status}`);
    const quiz = await res2.json() as any;
    assert(quiz.id === 'quiz', 'Quiz id must match');
    console.log('✓ 3. GET /api/admin/prompts/:id returned single prompt successfully');

    // 3. POST preview
    const res3 = await fetch(`${baseUrl}/api/admin/prompts/macro_curriculum/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        system_prompt: 'Test System for {course_title}',
        user_prompt: 'Test User for {course_title} with {duration_desc}',
        sample_variables: { course_title: 'Unit Test Kurs' }
      })
    });
    assert(res3.status === 200, `Preview should return 200, got ${res3.status}`);
    const preview = await res3.json() as any;
    assert(preview.success === true, 'Preview success must be true');
    assert(preview.rendered_system_prompt.includes('Unit Test Kurs'), 'Rendered system prompt must contain course title');
    assert(preview.rendered_user_prompt.includes('Unit Test Kurs'), 'Rendered user prompt must contain course title');
    console.log('✓ 4. POST /api/admin/prompts/:id/preview rendered template variables safely');

    // 4. PUT update prompt
    const originalUsr = quiz.user_prompt;
    const res4 = await fetch(`${baseUrl}/api/admin/prompts/quiz`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        system_prompt: quiz.system_prompt,
        user_prompt: originalUsr + '\n// MODIFIED FOR TEST'
      })
    });
    assert(res4.status === 200, 'PUT prompt must return 200');
    const updated = await res4.json() as any;
    assert(updated.success === true, 'Updated success must be true');
    assert(updated.prompt.is_customized === true, 'Prompt must be marked as customized');
    console.log('✓ 5. PUT /api/admin/prompts/:id saved customized prompt');

    // 5. POST reset prompt
    const res5 = await fetch(`${baseUrl}/api/admin/prompts/quiz/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders }
    });
    assert(res5.status === 200, 'POST reset must return 200');
    const reset = await res5.json() as any;
    assert(reset.success === true, 'Reset success must be true');
    assert(reset.prompt.is_customized === false, 'Reset prompt must not be customized');
    assert(reset.prompt.user_prompt === reset.prompt.default_user_prompt, 'User prompt must equal default');
    console.log('✓ 6. POST /api/admin/prompts/:id/reset restored factory default');

    console.log('\n========================================');
    console.log(' ALL PROMPT API TESTS PASSED SUCCESSFULLY! ');
    console.log('========================================');
  } finally {
    server.close();
  }
}

run().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
