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
      ? (recoveryInstruction ? 'Edit & Recover' : 'Correct / Replay Brain')
      : recoveryActionLabel(status.mode, status.action_label);

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
      if (typeof loadAll === 'function') await loadAll();
      if (typeof openMissionDetail === 'function') await openMissionDetail(missionId);
    } catch (error) {
      showToast(`Recovery failed: ${error.message}`, true);
    } finally {
      button.disabled = false;
    }
  }

  function recoveryActionLabel(mode, fallback = '') {
    if (mode === 'BRAIN_REPLAY' || mode === 'BRAIN_CORRECTIVE_REPLAY') return 'Correct / Replay Brain';
    if (mode === 'EXECUTION_RETRY') return 'Retry Execution';
    if (mode === 'HUMAN_ACTION_RESUME') return 'Resume Mission';
    if (mode === 'AUTOPILOT_RESUME') return 'Resume Autopilot';
    return fallback || 'Recover Mission';
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
      primary.textContent = recoveryActionLabel(currentRecovery.mode, currentRecovery.action_label);
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
    const recoveryButton = event.target.closest?.('[data-mission-center-recovery]');
    if (recoveryButton) {
      event.preventDefault();
      event.stopPropagation();
      const missionId = recoveryButton.dataset.missionId;
      if (missionId) void performRecovery(missionId, recoveryButton, recoveryButton.dataset.recoveryMode === 'BRAIN_REPLAY');
      return;
    }

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

  window.mrapiMissionRecovery = { recoveryStatus, recoveryActionLabel };
})();
