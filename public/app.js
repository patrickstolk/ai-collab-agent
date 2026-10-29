// Kleine hulpfuncties voor de webinterface (geen inline scripts vanwege de CSP).
(function () {
  function flash(btn, text) {
    const old = btn.textContent;
    btn.textContent = text;
    setTimeout(function () { btn.textContent = old; }, 1800);
  }

  // Prompt kopiëren. navigator.clipboard werkt alleen via HTTPS of localhost;
  // daarbuiten valt de knop terug op selecteren + execCommand.
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const ta = document.getElementById(btn.dataset.copy);
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(ta.value).then(function () { flash(btn, 'Gekopieerd ✓'); }, fallback);
      } else {
        fallback();
      }
      function fallback() {
        ta.removeAttribute('readonly');
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        ta.setAttribute('readonly', '');
        flash(btn, ok ? 'Gekopieerd ✓' : 'Geselecteerd: druk Ctrl+C');
      }
    });
  });

  document.querySelectorAll('[data-download]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const ta = document.getElementById(btn.dataset.download);
      const blob = new Blob([ta.value], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = btn.dataset.filename || 'prompt.txt';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    });
  });

  document.querySelectorAll('form[data-confirm]').forEach(function (f) {
    f.addEventListener('submit', function (e) {
      if (!window.confirm(f.dataset.confirm)) e.preventDefault();
    });
  });

  // Voorkom dubbel versturen (de server weigert dubbele stappen ook zelf).
  document.querySelectorAll('form[data-once]').forEach(function (f) {
    f.addEventListener('submit', function (e) {
      if (e.defaultPrevented) return;
      if (f.dataset.sent) { e.preventDefault(); return; }
      f.dataset.sent = '1';
      setTimeout(function () {
        f.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
      }, 0);
    });
  });

  // Automatisch verversen zolang een verwerking loopt.
  const poll = document.querySelector('[data-poll]');
  if (poll) {
    const start = poll.dataset.state;
    const timer = setInterval(function () {
      fetch(poll.dataset.poll, { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (d) { if (d.state !== start) { clearInterval(timer); location.reload(); } })
        .catch(function () { /* opnieuw bij volgende tik */ });
    }, 2500);
  }
})();
