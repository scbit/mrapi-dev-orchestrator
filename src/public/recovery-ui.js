(() => {
  let currentMissionId = null;
  let currentRecovery = null;

  async function recoveryStatus(missionId) {
    try {
      return await api(`/api/missions/${encodeURIComponent(missionId)}/recovery`);
    } catch (error) {
      console.warn('[MRAPI RECOVERY] status unavailable', missionId, error.message);
      return null;
    }
  }

  async function performRecovery(missionId, button) {
    const status = currentMissionId === missionId && currentRecovery
      ? currentRecovery
      : await recoveryStatus(missionId);

    if (!status?.recoverable) {
      showToast('This Mission does not currently need recovery.');
      return;
    }

    if (!confirm(`${status.action_label || 'Recover Mission'} for this Mission?`)) return;

    button.disabled = true;
    try {
      await api(`/api/missions/${encodeURIComponent(missionId)}/recover`, {
        method: 'POST',
        body: '{}'
      });
      currentRecovery = null;
      showToast(`${status.action_label || 'Recovery'} started.`);
      if (typeof closeMissionDetail === 'function') closeMissionDetail();
      if (typeof loadAll === 'function') await loadAll();
    } catch (error) {
      showToast(`Recovery failed: ${error.message}`, true);
    } finally {
      button.disabled = false;
    }
  }

  function removeLegacyRetry(container) {
    if (!container) return;
    for (const button of container.querySelectorAll('.retry-button')) {
      button.style.display = 'none';
    }
  }

  async function decorateMissionDetail(missionId) {
    const modal = document.querySelector('#missionDetailModal');
    if (!modal || modal.hidden) return;

    const actions = modal.querySelector('.modal-actions > div');
    if (!actions) return;

    currentMissionId = missionId;
    currentRecovery = await recoveryStatus(missionId);

    if (currentMissionId !== missionId) return;

    removeLegacyRetry(actions);
    actions.querySelector('.mrapi-recovery-button')?.remove();

    if (!currentRecovery?.recoverable) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost-button mrapi-recovery-button';
    button.dataset.missionId = missionId;
    button.textContent = currentRecovery.action_label || 'Recover Mission';
    button.title = currentRecovery.reason || '';
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await performRecovery(missionId, button);
    });

    actions.prepend(button);
  }

  // Important: do NOT call /recovery for every Mission row.
  // Only resolve recovery for the Mission the operator explicitly opens.
  document.addEventListener('click', (event) => {
    const row = event.target.closest?.('[data-open-mission]');
    if (!row) return;

    const missionId = row.dataset.openMission;
    if (!missionId) return;

    currentMissionId = missionId;
    currentRecovery = null;

    setTimeout(() => {
      void decorateMissionDetail(missionId);
    }, 80);
  }, true);

  const observer = new MutationObserver(() => {
    const modal = document.querySelector('#missionDetailModal');
    if (!modal || modal.hidden || !currentMissionId) return;

    const actions = modal.querySelector('.modal-actions > div');
    if (!actions) return;

    if (
      currentRecovery?.recoverable &&
      !actions.querySelector('.mrapi-recovery-button')
    ) {
      void decorateMissionDetail(currentMissionId);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
})(); 
