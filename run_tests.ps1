# PowerShell script to run migrations and integration tests
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "   Running KI E-Learning Integration Tests   " -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan

# 1. Run migrations
Write-Host "Applying database migrations..." -ForegroundColor Yellow
$migrateResult = npx.cmd drizzle-kit generate
$migrateDbResult = npx.cmd tsx src/db/migrations.ts

if ($LASTEXITCODE -ne 0) {
    Write-Host "Migration failed!" -ForegroundColor Red
    Exit 1
}

# 2. Run test script
Write-Host "Executing backend integration tests..." -ForegroundColor Yellow
npx.cmd tsx tests/backend.test.ts

if ($LASTEXITCODE -ne 0) {
    Write-Host "Tests failed!" -ForegroundColor Red
    Exit 1
}

Write-Host "Tests completed successfully!" -ForegroundColor Green
Exit 0
