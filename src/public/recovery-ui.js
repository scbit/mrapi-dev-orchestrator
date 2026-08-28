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

  async function performRecovery(missionId, button, editInstruction = false) {
    const status = currentMissionId === missionId && currentRecovery
      ? currentRecovery
      : await recoveryStatus(missionId);

    if (!status?.recoverable) {
      showToast('This Mission does not currently need recovery.');
      return;
    }

    let recoveryInstruction = '';
    if (editInstruction && status.mode === 'BRAIN_REPLAY') {
      const entered = prompt(
        'Optional correction for the next Brain attempt:',
        ''
      );
      if (entered === null) return;
      recoveryInstruction = entered.trim();
    }

    const label = status.mode === 'BRAIN_REPLAY'
      ? (recoveryInstruction ? 'Edit & Recover' : 'Recover & Correct')
      : (status.action_label || 'Recover Mission');

    if (!confirm(`${label} for this Mission?`)) return;

    button.disabled = true;
    try {
      await api(`/api/missions/${encodeURIComponent(missionId)}/recover`, {
        method: 'POST',
        body: JSON.stringify({
          recovery_instruction: recoveryInstruction || null
        })
      });

      currentRecovery = null;
      showToast(`${label} started.`);
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

      actions.querySelectorAll('.mrapi-recovery-button').forEach((el) => el.remove());

      const legacyRetry = actions.querySelector('.retry-button');

      if (!currentRecovery?.recoverable) {
        if (legacyRetry) legacyRetry.style.display = '';
        return;
      }

      if (legacyRetry) legacyRetry.style.display = 'none';

      const primary = document.createElement('button');
      primary.type = 'button';
      primary.className = 'ghost-button mrapi-recovery-button';
      primary.dataset.missionId = missionId;
      primary.textContent = currentRecovery.mode === 'BRAIN_REPLAY'
        ? 'Recover & Correct'
        : (currentRecovery.action_label || 'Recover Mission');
      primary.title = currentRecovery.reason || '';
      primary.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await performRecovery(missionId, primary, false);
      });

      actions.prepend(primary);

      if (currentRecovery.mode === 'BRAIN_REPLAY') {
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'ghost-button mrapi-recovery-button';
        edit.dataset.missionId = missionId;
        edit.textContent = 'Edit & Recover';
        edit.title = 'Add an operator correction before replaying Brain.';
        edit.addEventListener('click', async (event) => {
          event.preventDefault();
          event.stopPropagation();
          await performRecovery(missionId, edit, true);
        });
        primary.after(edit);
      }
    } finally {
      decorating = false;
    }
  }

  document.addEventListener('click', (event) => {
    const row = event.target.closest?.('[data-open-mission]');
    if (!row) return;
    const missionId = row.dataset.openMission;
    if (!missionId) return;
    currentMissionId = missionId;
    currentRecovery = null;
  }, true);

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
