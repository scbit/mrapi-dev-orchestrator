(() => {
  let currentMissionId = null;
  let currentRecovery = null;
  let decorating = false;

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

  async function decorateMissionDetail(missionId) {
    const modal = document.querySelector('#missionDetailModal');
    if (!modal || modal.hidden || !missionId || decorating) return;

    const actions = modal.querySelector('.modal-actions > div');
    if (!actions) return;

    decorating = true;
    try {
      currentMissionId = missionId;
      currentRecovery = await recoveryStatus(missionId);

      if (currentMissionId !== missionId || modal.hidden) return;

      actions.querySelector('.mrapi-recovery-button')?.remove();

      const legacyRetry = actions.querySelector('.retry-button');

      if (!currentRecovery?.recoverable) {
        if (legacyRetry) legacyRetry.style.display = '';
        return;
      }

      if (legacyRetry) legacyRetry.style.display = 'none';

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
    } finally {
      decorating = false;
    }
  }

  // Capture which Mission the user intends to open.
  document.addEventListener('click', (event) => {
    const row = event.target.closest?.('[data-open-mission]');
    if (!row) return;
    const missionId = row.dataset.openMission;
    if (!missionId) return;
    currentMissionId = missionId;
    currentRecovery = null;
  }, true);

  // Critical fix: observe the modal's "hidden" attribute.
  // openMissionDetail fills the modal while hidden, then removes hidden.
  const modal = document.querySelector('#missionDetailModal');
  if (modal) {
    const modalObserver = new MutationObserver(() => {
      if (!modal.hidden && currentMissionId) {
        void decorateMissionDetail(currentMissionId);
      }
    });
    modalObserver.observe(modal, {
      attributes: true,
      attributeFilter: ['hidden'],
      childList: true,
      subtree: true
    });
  }
})();
