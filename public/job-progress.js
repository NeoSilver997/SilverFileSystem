(function (global) {
  function ensureBar(hostEl) {
    if (!hostEl) return null;
    let wrap = hostEl.querySelector('.job-progress-wrap');
    if (wrap) return wrap;
    wrap = document.createElement('div');
    wrap.className = 'job-progress-wrap';
    wrap.innerHTML =
      '<div class="job-progress-label"></div>' +
      '<div class="job-progress-track"><div class="job-progress-fill"></div></div>' +
      '<div class="job-progress-meta"></div>';
    hostEl.appendChild(wrap);
    if (!document.getElementById('job-progress-style')) {
      const style = document.createElement('style');
      style.id = 'job-progress-style';
      style.textContent =
        '.job-progress-wrap{margin:0.5rem 0 0.75rem;max-width:640px}' +
        '.job-progress-label{font-size:0.85rem;margin-bottom:0.25rem;color:#9aa0a6}' +
        '.job-progress-track{height:10px;background:#222938;border-radius:999px;overflow:hidden;border:1px solid #3a4358}' +
        '.job-progress-fill{height:100%;width:0%;background:linear-gradient(90deg,#9b59b6,#8ab4f8);transition:width .25s ease}' +
        '.job-progress-meta{font-size:0.8rem;color:#9aa0a6;margin-top:0.25rem}' +
        '.job-progress-wrap.error .job-progress-fill{background:#e74c3c}' +
        '.job-progress-wrap.done .job-progress-fill{background:#2ecc71}' +
        '.job-progress-wrap.cancelled .job-progress-fill{background:#95a5a6}';
      document.head.appendChild(style);
    }
    return wrap;
  }

  function setBar(wrap, job) {
    if (!wrap || !job) return;
    wrap.classList.toggle('error', job.status === 'error');
    wrap.classList.toggle('done', job.status === 'done');
    wrap.classList.toggle('cancelled', job.status === 'cancelled');
    const fill = wrap.querySelector('.job-progress-fill');
    const label = wrap.querySelector('.job-progress-label');
    const meta = wrap.querySelector('.job-progress-meta');
    const pct = typeof job.percent === 'number' ? job.percent : 0;
    if (fill) fill.style.width = Math.max(pct, job.status === 'queued' ? 2 : 0) + '%';
    if (label) {
      label.textContent = (job.message || job.type || 'Job') +
        (job.currentItem ? ' — ' + job.currentItem : '');
    }
    if (meta) {
      const parts = [
        pct + '%',
        (job.done != null && job.total != null) ? (job.done + ' / ' + job.total) : null,
        job.status,
        job.id ? ('#' + job.id.slice(0, 8)) : null
      ].filter(Boolean);
      if (job.error) parts.push(job.error);
      meta.textContent = parts.join(' · ');
    }
  }

  async function fetchJob(jobId, fetchFn) {
    const fn = fetchFn || ((url, opts) => fetch(url, { credentials: 'include', ...(opts || {}) }));
    const r = await fn('/api/jobs/' + encodeURIComponent(jobId));
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    return data;
  }

  async function poll(jobId, opts) {
    const options = opts || {};
    const intervalMs = options.intervalMs || 500;
    const wrap = options.host ? ensureBar(options.host) : null;
    let last = null;
    while (true) {
      last = await fetchJob(jobId, options.fetchFn);
      if (wrap) setBar(wrap, last);
      if (typeof options.onUpdate === 'function') options.onUpdate(last, wrap);
      if (last.status === 'done' || last.status === 'error' || last.status === 'cancelled') return last;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  function resultUrl(jobId) {
    return '/jobs?id=' + encodeURIComponent(jobId);
  }

  global.JobProgress = { ensureBar, setBar, poll, fetchJob, resultUrl };
})(typeof window !== 'undefined' ? window : globalThis);