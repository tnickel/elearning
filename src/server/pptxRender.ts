import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface RenderedSlideImage {
  index: number;
  fileName: string;
  absolutePath: string;
  /** Relative URL under /slides/{courseId}/... after moveToCourseDir */
  imageUrl?: string;
}

function findPdftoppm(): string {
  const localAppData = process.env.LOCALAPPDATA || '';
  const candidates = [
    process.env.PDFTOPPM_PATH,
    localAppData ? path.join(localAppData, 'Programs', 'MiKTeX', 'miktex', 'bin', 'x64', 'pdftoppm.exe') : null,
    localAppData ? path.join(localAppData, 'Programs', 'MiKTeX2', 'miktex', 'bin', 'x64', 'pdftoppm.exe') : null,
    'pdftoppm',
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    if (c === 'pdftoppm') return c;
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    'pdftoppm nicht gefunden. Bitte MiKTeX/Poppler installieren oder PDFTOPPM_PATH setzen.'
  );
}

/**
 * Export PPTX → PDF via PowerPoint COM, then PDF pages → PNG via pdftoppm.
 * Returns absolute paths to PNGs in a temp directory (caller should move/copy).
 */
export async function renderPptxToPngs(
  pptxBuffer: Buffer,
  options: { dpi?: number; timeoutMs?: number } = {}
): Promise<{ workDir: string; slides: RenderedSlideImage[] }> {
  const dpi = options.dpi ?? 150;
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elearning-pptx-'));
  const pptxPath = path.join(workDir, 'input.pptx');
  const pdfPath = path.join(workDir, 'export.pdf');
  const pngPrefix = path.join(workDir, 'slide');

  fs.writeFileSync(pptxPath, pptxBuffer);

  // PowerPoint COM: SaveAs PDF (ppSaveAsPDF = 32)
  const psScript = `
$ErrorActionPreference = 'Stop'
$pptPath = ${JSON.stringify(pptxPath)}
$pdfPath = ${JSON.stringify(pdfPath)}
$app = New-Object -ComObject PowerPoint.Application
try {
  # Visible=$false is not always supported; WithWindow=$false keeps UI quiet
  $pres = $app.Presentations.Open($pptPath, $true, $false, $false)
  try {
    $pres.SaveAs($pdfPath, 32)
  } finally {
    $pres.Close()
  }
} finally {
  $app.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
if (-not (Test-Path -LiteralPath $pdfPath)) {
  throw "PDF export failed: file not created"
}
`;

  const psFile = path.join(workDir, 'export.ps1');
  fs.writeFileSync(psFile, psScript, 'utf8');

  try {
    await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile],
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }
    );
  } catch (err: any) {
    const detail = err.stderr || err.stdout || err.message;
    throw new Error(
      `PowerPoint-PDF-Export fehlgeschlagen. Ist Microsoft PowerPoint installiert? Details: ${detail}`
    );
  }

  if (!fs.existsSync(pdfPath)) {
    throw new Error('PowerPoint hat keine PDF-Datei erzeugt.');
  }

  const pdftoppm = findPdftoppm();
  try {
    await execFileAsync(
      pdftoppm,
      ['-png', '-r', String(dpi), pdfPath, pngPrefix],
      { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 }
    );
  } catch (err: any) {
    const detail = err.stderr || err.stdout || err.message;
    throw new Error(`pdftoppm fehlgeschlagen: ${detail}`);
  }

  const pngFiles = fs
    .readdirSync(workDir)
    .filter((f) => /^slide-\d+\.png$/i.test(f) || /^slide\d+\.png$/i.test(f))
    .sort((a, b) => {
      const na = parseInt(a.replace(/\D/g, ''), 10);
      const nb = parseInt(b.replace(/\D/g, ''), 10);
      return na - nb;
    });

  if (pngFiles.length === 0) {
    throw new Error('Keine Folien-PNGs erzeugt (pdftoppm Output leer).');
  }

  const slides: RenderedSlideImage[] = pngFiles.map((fileName, i) => ({
    index: i,
    fileName,
    absolutePath: path.join(workDir, fileName),
  }));

  return { workDir, slides };
}

/**
 * Copy rendered PNGs into public/slides/{courseId}/ as slide-001.png, ...
 */
export function publishSlideImages(
  courseId: string,
  rendered: RenderedSlideImage[]
): RenderedSlideImage[] {
  const outDir = path.join(process.cwd(), 'public', 'slides', courseId);
  fs.mkdirSync(outDir, { recursive: true });

  return rendered.map((s, i) => {
    const pad = String(i + 1).padStart(3, '0');
    const destName = `slide-${pad}.png`;
    const destPath = path.join(outDir, destName);
    fs.copyFileSync(s.absolutePath, destPath);
    return {
      ...s,
      fileName: destName,
      absolutePath: destPath,
      imageUrl: `/slides/${courseId}/${destName}`,
    };
  });
}

export function cleanupWorkDir(workDir: string) {
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
