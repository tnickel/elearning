import * as fs from 'fs';
import * as path from 'path';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';

const execFileAsync = promisify(execFile);

export type ExportImageCue = {
  timestamp_percent?: number;
  image_url: string;
  transition?: string;
};

export type ExportSlide = {
  index?: number;
  layout?: string;
  title?: string;
  bullets?: string[];
  codeSnippet?: string;
  codeLanguage?: string;
  mermaidCode?: string;
  imageUrl?: string; // /slides/...
  imageCues?: ExportImageCue[];
  audioUrl?: string; // /audio/...
};

export type ExportProgress = {
  status: 'idle' | 'running' | 'ready' | 'failed';
  percent: number;
  step: string;
  downloadUrl?: string;
  error?: string;
  updatedAt?: string;
};

export function findBrowser(): string | null {
  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

  const candidates = [
    process.env.CHROME_PATH,
    process.env.EDGE_PATH,
    path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    localAppData ? path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
    localAppData ? path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function escapeHtml(str?: string): string {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function imageToDataUri(imageUrl?: string): string | null {
  if (!imageUrl) return null;
  try {
    const abs = publicPathFromUrl(imageUrl);
    if (!fs.existsSync(abs) || fs.statSync(abs).size === 0) return null;
    const ext = path.extname(abs).slice(1).toLowerCase() || 'png';
    const mime = ext === 'jpg' ? 'jpeg' : ext;
    const b64 = fs.readFileSync(abs).toString('base64');
    return `data:image/${mime};base64,${b64}`;
  } catch {
    return null;
  }
}

export function generateSlideHtml(opts: {
  slide: ExportSlide;
  slideIndex: number;
  totalSlides: number;
  overrideImageUrl?: string;
}): string {
  const { slide, slideIndex, totalSlides, overrideImageUrl } = opts;
  const layout = slide.layout || 'bullets';
  const title = slide.title || `Folie ${slideIndex + 1}`;
  const bullets = slide.bullets || [];
  const imageUrl = overrideImageUrl || slide.imageUrl;
  const dataUri = imageToDataUri(imageUrl);

  let rightColumnHtml = '';
  if (layout === 'code' && slide.codeSnippet) {
    rightColumnHtml = `
      <div class="code-card">
        <div class="code-header">
          <div class="dots">
            <span class="dot dot-red"></span>
            <span class="dot dot-yellow"></span>
            <span class="dot dot-green"></span>
          </div>
          <span class="filename">${escapeHtml(slide.codeLanguage || 'code')}</span>
        </div>
        <pre class="code-pre"><code>${escapeHtml(slide.codeSnippet)}</code></pre>
      </div>`;
  } else if (dataUri) {
    rightColumnHtml = `
      <div class="image-card">
        <img class="slide-img" src="${dataUri}" alt="Folie" />
      </div>`;
  }

  const bulletsHtml = bullets.map(b => `<li class="bullet-item">${escapeHtml(b)}</li>`).join('\n');

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  body {
    width: 1920px;
    height: 1080px;
    overflow: hidden;
    background: radial-gradient(ellipse at top right, rgba(6, 182, 212, 0.22), transparent 50%),
                radial-gradient(ellipse at bottom left, rgba(99, 102, 241, 0.26), transparent 55%),
                linear-gradient(160deg, #10182a 0%, #0b1220 55%, #121a2e 100%);
    color: #f3f4f6;
    display: flex;
    flex-direction: column;
    padding: 70px 90px 48px 90px;
    justify-content: space-between;
  }
  .stage-content {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 60px;
    width: 100%;
  }
  .text-column {
    flex: ${rightColumnHtml ? '1.1' : '1'};
    max-width: ${rightColumnHtml ? '960px' : '1400px'};
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  .eyebrow {
    font-size: 20px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: #06b6d4;
    margin-bottom: 16px;
  }
  .title {
    font-size: 54px;
    font-weight: 700;
    line-height: 1.22;
    color: #ffffff;
    margin-bottom: 38px;
    text-shadow: 0 2px 10px rgba(0,0,0,0.3);
  }
  .bullet-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 22px;
  }
  .bullet-item {
    position: relative;
    padding-left: 36px;
    font-size: 28px;
    line-height: 1.55;
    color: #e2e8f0;
  }
  .bullet-item::before {
    content: '';
    position: absolute;
    left: 4px;
    top: 14px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #8b5cf6;
    box-shadow: 0 0 12px #8b5cf6;
  }
  .right-column {
    flex: 0.9;
    display: flex;
    justify-content: center;
    align-items: center;
  }
  .image-card {
    width: 100%;
    max-width: 720px;
    aspect-ratio: 16 / 9;
    border-radius: 18px;
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.12);
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5), 0 0 30px rgba(139, 92, 246, 0.15);
    background: rgba(15, 23, 42, 0.6);
  }
  .slide-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .code-card {
    width: 100%;
    max-width: 760px;
    border-radius: 16px;
    background: #070913;
    border: 1px solid rgba(255, 255, 255, 0.1);
    box-shadow: 0 20px 50px rgba(0,0,0,0.5);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .code-header {
    background: rgba(255, 255, 255, 0.04);
    padding: 12px 18px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .dots { display: flex; gap: 8px; }
  .dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
  .dot-red { background: #ef4444; }
  .dot-yellow { background: #eab308; }
  .dot-green { background: #22c55e; }
  .filename { font-size: 16px; color: #fff; font-family: monospace; }
  .code-pre {
    margin: 0;
    padding: 24px;
    font-size: 20px;
    line-height: 1.6;
    color: #a78bfa;
    font-family: 'Fira Code', Consolas, Monaco, monospace;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 520px;
    overflow: hidden;
  }
  .footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    padding-top: 20px;
    font-size: 20px;
    color: #94a3b8;
  }
</style>
</head>
<body>
  <div class="stage-content">
    <div class="text-column">
      <div class="eyebrow">Präsentationsfolie</div>
      <h1 class="title">${escapeHtml(title)}</h1>
      <ul class="bullet-list">
        ${bulletsHtml}
      </ul>
    </div>
    ${rightColumnHtml ? `<div class="right-column">${rightColumnHtml}</div>` : ''}
  </div>
  <div class="footer">
    <span>Folie ${slideIndex + 1} von ${totalSlides}</span>
    <span>Folien-Vertonung</span>
  </div>
</body>
</html>`;
}

export async function renderSlideToPng(opts: {
  browserPath: string;
  htmlContent: string;
  outPngPath: string;
  tempHtmlPath: string;
}): Promise<void> {
  const { browserPath, htmlContent, outPngPath, tempHtmlPath } = opts;
  fs.writeFileSync(tempHtmlPath, htmlContent, 'utf8');
  try {
    await execFileAsync(browserPath, [
      '--headless=new',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--screenshot=${outPngPath}`,
      '--window-size=1920,1080',
      `file://${tempHtmlPath}`,
    ], { timeout: 30000 });
  } finally {
    try {
      if (fs.existsSync(tempHtmlPath)) fs.unlinkSync(tempHtmlPath);
    } catch {
      /* ignore */
    }
  }
}

function runCmd(bin: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 12000) stderr = stderr.slice(-8000);
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${bin} exited ${code}: ${stderr.slice(-1500)}`));
    });
  });
}

function getAudioDuration(audioAbs: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      audioAbs,
    ], { windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.on('close', (code) => {
      const dur = parseFloat(stdout.trim());
      if (code === 0 && Number.isFinite(dur) && dur > 0) {
        resolve(dur);
      } else {
        resolve(0);
      }
    });
    child.on('error', () => resolve(0));
  });
}

function publicPathFromUrl(url: string): string {
  if (path.isAbsolute(url) && fs.existsSync(url)) {
    return url;
  }
  const rel = String(url || '').replace(/^\//, '').split('?')[0];
  const abs = path.resolve(process.cwd(), 'public', rel);
  const root = path.resolve(process.cwd(), 'public');
  // Compare against root + path.sep so sibling directories like "public_evil"
  // cannot pass a plain startsWith(root) check.
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Path traversal attempt detected in video export URL: ${url}`);
  }
  return abs;
}

function slugify(input: string): string {
  return (input || 'kurs')
    .toLowerCase()
    .replace(/[äÄ]/g, 'ae')
    .replace(/[öÖ]/g, 'oe')
    .replace(/[üÜ]/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'kurs';
}

const SCALE =
  "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30";

function mapTransition(name?: string): string {
  if (!name) return 'fade';
  const clean = name.toLowerCase().replace(/[-_]/g, '');
  const supported: Record<string, string> = {
    fade: 'fade',
    slideleft: 'slideleft',
    slideright: 'slideright',
    slideup: 'slideup',
    slidedown: 'slidedown',
    wipeleft: 'wipeleft',
    wiperight: 'wiperight',
    wipeup: 'wipeup',
    wipedown: 'wipedown',
    zoomin: 'zoomin',
    dissolve: 'dissolve',
    pixelize: 'pixelize',
  };
  return supported[clean] || 'fade';
}

async function buildMultiCueSegment(opts: {
  cues: Array<{ imageAbs: string; timestamp_percent: number; transition: string }>;
  audioAbs?: string;
  totalDuration: number;
  outAbs: string;
}): Promise<void> {
  const { cues, audioAbs, totalDuration, outAbs } = opts;
  const N = cues.length;

  // Calculate start timestamps for each cue
  const t: number[] = [0];
  for (let i = 1; i < N; i++) {
    const rawT = (cues[i].timestamp_percent / 100) * totalDuration;
    const minT = t[i - 1] + 0.5;
    const maxT = totalDuration - 0.5;
    t.push(Math.min(maxT, Math.max(minT, rawT)));
  }

  // Calculate transition durations
  const transDurs: number[] = [0];
  for (let i = 1; i < N; i++) {
    const interval = t[i] - t[i - 1];
    transDurs.push(Math.min(1.0, interval / 2));
  }

  // Calculate required video clip durations
  const durations: number[] = [];
  for (let i = 0; i < N; i++) {
    if (i === N - 1) {
      durations.push(Math.max(1.0, totalDuration - t[i]));
    } else {
      durations.push((t[i + 1] - t[i]) + transDurs[i + 1]);
    }
  }

  const inputArgs: string[] = [];
  for (let i = 0; i < N; i++) {
    inputArgs.push('-loop', '1', '-t', durations[i].toFixed(3), '-i', cues[i].imageAbs);
  }

  if (audioAbs && fs.existsSync(audioAbs)) {
    inputArgs.push('-i', audioAbs);
  } else {
    inputArgs.push(
      '-f', 'lavfi',
      '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-t', totalDuration.toFixed(3)
    );
  }

  const filterParts: string[] = [];
  for (let i = 0; i < N; i++) {
    filterParts.push(`[${i}:v]${SCALE}[v${i}]`);
  }

  let lastOut = 'v0';
  for (let i = 1; i < N; i++) {
    const nextOut = i === N - 1 ? 'vout' : `x${i}`;
    const trans = cues[i].transition || 'fade';
    const td = transDurs[i].toFixed(3);
    const offset = t[i].toFixed(3);
    filterParts.push(`[${lastOut}][v${i}]xfade=transition=${trans}:duration=${td}:offset=${offset}[${nextOut}]`);
    lastOut = nextOut;
  }

  await runCmd('ffmpeg', [
    '-y',
    ...inputArgs,
    '-filter_complex', filterParts.join(';'),
    '-map', '[vout]',
    '-map', `${N}:a`,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '44100',
    '-ac', '2',
    '-shortest',
    '-movflags', '+faststart',
    outAbs,
  ]);
}

async function buildSegment(opts: {
  imageAbs?: string;
  imageCues?: ExportImageCue[];
  audioAbs?: string;
  outAbs: string;
  silentSeconds?: number;
}): Promise<void> {
  const hasAudio = !!(opts.audioAbs && fs.existsSync(opts.audioAbs) && fs.statSync(opts.audioAbs).size > 0);
  const audioDuration = hasAudio ? await getAudioDuration(opts.audioAbs!) : 0;
  const totalDuration = audioDuration > 0 ? audioDuration : (opts.silentSeconds ?? 4);

  // Validate and collect valid cues
  const validCues: Array<{ imageAbs: string; timestamp_percent: number; transition: string }> = [];
  if (opts.imageCues && Array.isArray(opts.imageCues)) {
    for (const cue of opts.imageCues) {
      if (!cue.image_url) continue;
      try {
        const abs = publicPathFromUrl(cue.image_url);
        if (fs.existsSync(abs) && fs.statSync(abs).size > 0) {
          validCues.push({
            imageAbs: abs,
            timestamp_percent: typeof cue.timestamp_percent === 'number' ? cue.timestamp_percent : 0,
            transition: mapTransition(cue.transition),
          });
        }
      } catch {
        /* invalid path / traversal attempt, ignore cue */
      }
    }
  }

  // If we have at least 2 distinct cue images and positive duration, render with xfade transitions
  if (validCues.length >= 2 && totalDuration > 1) {
    try {
      await buildMultiCueSegment({
        cues: validCues,
        audioAbs: hasAudio ? opts.audioAbs : undefined,
        totalDuration,
        outAbs: opts.outAbs,
      });
      return;
    } catch (err) {
      console.warn('[VIDEO EXPORT] xfade multi-cue failed, falling back to single image:', err);
    }
  }

  // Fallback to single image segment (either opts.imageAbs or first valid cue image)
  let fallbackImageAbs = opts.imageAbs;
  if (!fallbackImageAbs || !fs.existsSync(fallbackImageAbs)) {
    if (validCues.length > 0) {
      fallbackImageAbs = validCues[0].imageAbs;
    }
  }
  if (!fallbackImageAbs || !fs.existsSync(fallbackImageAbs)) {
    throw new Error(`Folienbild fehlt oder existiert nicht: ${opts.imageAbs || 'unbekannt'}`);
  }

  const commonVideo = [
    '-loop', '1',
    '-i', fallbackImageAbs,
  ];

  if (hasAudio) {
    await runCmd('ffmpeg', [
      '-y',
      ...commonVideo,
      '-i', opts.audioAbs!,
      '-c:v', 'libx264',
      '-tune', 'stillimage',
      '-pix_fmt', 'yuv420p',
      '-vf', SCALE,
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '44100',
      '-ac', '2',
      '-shortest',
      '-movflags', '+faststart',
      opts.outAbs,
    ]);
  } else {
    const secs = opts.silentSeconds ?? 4;
    await runCmd('ffmpeg', [
      '-y',
      ...commonVideo,
      '-f', 'lavfi',
      '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-t', String(secs),
      '-c:v', 'libx264',
      '-tune', 'stillimage',
      '-pix_fmt', 'yuv420p',
      '-vf', SCALE,
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '44100',
      '-ac', '2',
      '-shortest',
      '-movflags', '+faststart',
      opts.outAbs,
    ]);
  }
}

/**
 * Build one MP4 from slide images + per-slide audio (Ken Burns-free still frames).
 * Returns public URL path e.g. /exports/{courseId}/....mp4
 */
export async function exportCourseToMp4(opts: {
  courseId: string;
  topic: string;
  slides: ExportSlide[];
  onProgress?: (percent: number, step: string) => void | Promise<void>;
}): Promise<string> {
  if (!opts.slides.length) {
    throw new Error('Keine Folien zum Exportieren');
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `elearn-export-${opts.courseId.slice(0, 8)}-`));
  const outDir = path.join(process.cwd(), 'public', 'exports', opts.courseId);
  fs.mkdirSync(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outName = `${slugify(opts.topic)}-${stamp}.mp4`;
  const outAbs = path.join(outDir, outName);
  const concatListAbs = path.join(workDir, 'concat.txt');

  try {
    const segmentFiles: string[] = [];
    const browserPath = findBrowser();
    if (browserPath) {
      console.log(`[VIDEO EXPORT] Using browser for slide stage rendering: ${browserPath}`);
    } else {
      console.warn('[VIDEO EXPORT] No browser found, falling back to raw image export');
    }

    for (let i = 0; i < opts.slides.length; i++) {
      const slide = opts.slides[i];
      const pct = Math.round(((i) / opts.slides.length) * 85);
      await opts.onProgress?.(pct, `Rendere Folie ${i + 1}/${opts.slides.length}…`);

      const isFullSlidePptx = slide.layout === 'image' && (!slide.bullets || slide.bullets.length === 0) && (!slide.title || slide.title.startsWith('Folie '));

      let effectiveImageAbs: string | undefined;
      let effectiveCues: ExportImageCue[] | undefined;

      if (!isFullSlidePptx && browserPath) {
        try {
          if (slide.imageCues && slide.imageCues.length >= 2) {
            // Render each cue state of the slide stage in parallel
            const cueRenderPromises = slide.imageCues.map(async (cue, cIdx) => {
              const cuePng = path.join(workDir, `slide-${i}-cue-${cIdx}.png`);
              const cueHtml = path.join(workDir, `slide-${i}-cue-${cIdx}.html`);
              const html = generateSlideHtml({
                slide,
                slideIndex: i,
                totalSlides: opts.slides.length,
                overrideImageUrl: cue.image_url,
              });
              await renderSlideToPng({
                browserPath,
                htmlContent: html,
                outPngPath: cuePng,
                tempHtmlPath: cueHtml,
              });
              return {
                timestamp_percent: cue.timestamp_percent,
                image_url: cuePng,
                transition: cue.transition,
              };
            });
            effectiveCues = await Promise.all(cueRenderPromises);
          } else {
            // Render the single slide stage
            const slidePng = path.join(workDir, `slide-${i}.png`);
            const slideHtml = path.join(workDir, `slide-${i}.html`);
            const html = generateSlideHtml({
              slide,
              slideIndex: i,
              totalSlides: opts.slides.length,
            });
            await renderSlideToPng({
              browserPath,
              htmlContent: html,
              outPngPath: slidePng,
              tempHtmlPath: slideHtml,
            });
            effectiveImageAbs = slidePng;
          }
        } catch (renderErr) {
          console.warn(`[VIDEO EXPORT] Browser slide rendering failed for slide ${i + 1}, falling back to raw image:`, renderErr);
        }
      }

      if (!effectiveImageAbs && !effectiveCues) {
        if (slide.imageUrl) {
          try {
            const resolved = publicPathFromUrl(slide.imageUrl);
            if (fs.existsSync(resolved)) effectiveImageAbs = resolved;
          } catch {
            /* ignore */
          }
        }
        effectiveCues = slide.imageCues;
      }

      const audioAbs = slide.audioUrl ? publicPathFromUrl(slide.audioUrl) : undefined;
      const segAbs = path.join(workDir, `seg-${String(i).padStart(3, '0')}.mp4`);
      await buildSegment({
        imageAbs: effectiveImageAbs,
        imageCues: effectiveCues,
        audioAbs,
        outAbs: segAbs,
      });
      segmentFiles.push(segAbs);
    }

    await opts.onProgress?.(90, 'Füge Folien zu einem Video zusammen…');

    const listBody = segmentFiles
      .map((f) => `file '${f.replace(/\\/g, '/')}'`)
      .join('\n');
    fs.writeFileSync(concatListAbs, listBody, 'utf8');

    // Re-encode on concat for stream consistency across segments
    await runCmd('ffmpeg', [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatListAbs,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      outAbs,
    ]);

    await opts.onProgress?.(100, 'MP4-Export fertig');
    return `/exports/${opts.courseId}/${outName}`;
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  }
}
