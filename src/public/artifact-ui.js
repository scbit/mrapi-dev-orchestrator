(() => {
  state.evidence = state.evidence || [];

  function artifactsForMission(missionId) {
    return state.evidence.filter((x) => x.mission_id === missionId && x.storage && x.type !== 'LOG');
  }

  function fileCard(item) {
    const name = item.storage?.filename || item.title || 'Artifact';
    return `<a class="artifact-card" href="/api/evidence/${encodeURIComponent(item.id)}/download">
      <div><strong>${escapeHtml(name)}</strong><span>${escapeHtml(item.type || 'FILE')}</span></div>
      <b>Download ↓</b>
    </a>`;
  }

  function cleanResult(result) {
    const out = result.output || {};
    return `<div class="clean-result">
      <div>${stateBadge(result.status || 'SUCCESS')}</div>
      <div class="clean-summary">${escapeHtml(result.summary || 'Execution completed.')}</div>
      <details class="technical-details">
        <summary>Technical details</summary>
        <pre class="result-json">${escapeHtml(JSON.stringify({
          exit_code: out.exit_code,
          stdout_tail: out.stdout_tail,
          stderr_tail: out.stderr_tail
        }, null, 2))}</pre>
      </details>
    </div>`;
  }

  renderReports = function () {
    const results = state.results.filter((r) => r.result_type === 'EXECUTION_OUTPUT' || !r.result_type);
    $('#reportsList').innerHTML = results.length ? results.map((result) => {
      const mission = state.missions.find((m) => m.id === result.mission_id);
      const artifacts = artifactsForMission(result.mission_id);
      return `<article class="report-card">
        <div class="panel-header"><div><span class="eyebrow">FINAL RESULT</span>
        <h3>${escapeHtml(mission?.objective || result.mission_id || 'Execution result')}</h3></div>
        ${stateBadge(result.status || 'SUCCESS')}</div>
        ${cleanResult(result)}
        ${artifacts.length ? `<h4>Artifacts</h4><div class="artifact-list">${artifacts.map(fileCard).join('')}</div>` : ''}
      </article>`;
    }).join('') : '<div class="empty-state">No final execution results yet.</div>';
  };

  const previousLoadAll = loadAll;
  loadAll = async function () {
    await previousLoadAll();
    try {
      const evidence = await api('/api/evidence');
      state.evidence = evidence.items || [];
      renderReports();
      const target = $('#evidenceList');
      if (target) {
        target.innerHTML = state.evidence.length
          ? state.evidence.map((item) => `<article class="report-card">
              <div class="panel-header"><div><span class="eyebrow">${escapeHtml(item.type || 'EVIDENCE')}</span>
              <h3>${escapeHtml(item.title || item.storage?.filename || item.id)}</h3></div>
              ${item.storage?.object_path ? `<a class="ghost-button" href="/api/evidence/${encodeURIComponent(item.id)}/download">Download</a>` : ''}
              </div>
              <div class="mission-meta">Mission ${escapeHtml(item.mission_id || '—')} · Run ${escapeHtml(item.run_id || '—')}</div>
            </article>`).join('')
          : '<div class="empty-state">No evidence yet.</div>';
      }
    } catch (error) {
      console.error('[EVIDENCE LOAD]', error);
    }
  };

  loadAll();
})();
