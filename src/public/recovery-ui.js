(() => {
  const decoratedRows = new WeakSet();
  const recoveryCache = new Map();

  async function recoveryStatus(missionId, force = false) {
    if (!force && recoveryCache.has(missionId)) return recoveryCache.get(missionId);
    const promise = api(`/api/missions/${encodeURIComponent(missionId)}/recovery`)
      .catch(() => null);
    recoveryCache.set(missionId, promise);
    return promise;
  }

  async function performRecovery(missionId, button) {
    const status = await recoveryStatus(missionId, true);
    if (!status?.recoverable) {
      showToast('This Mission does not currently need recovery.');
      return;
    }

    if (!confirm(`${status.action_label || 'Recover Mission'} for this Mission?`)) return;

    button.disabled = true;
    try {
      const result = await api(`/api/missions/${encodeURIComponent(missionId)}/recover`, {
        method: 'POST',
        body: '{}'
      });
      recoveryCache.delete(missionId);
      showToast(`${status.action_label || 'Recovery'} started.`);
      if (typeof closeMissionDetail === 'function') closeMissionDetail();
      if (typeof loadAll === 'function') await loadAll();
      return result;
    } catch (error) {
      showToast(`Recovery failed: ${error.message}`, true);
    } finally {
      button.disabled = false;
    }
  }

  async function addRecoveryButton(container, missionId) {
    if (!container || container.querySelector(`.mrapi-recovery-button[data-mission-id="${CSS.escape(missionId)}"]`)) return;

    const status = await recoveryStatus(missionId);
    if (!status?.recoverable) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost-button mrapi-recovery-button';
    button.dataset.missionId = missionId;
    button.textContent = status.action_label || 'Recover Mission';
    button.title = status.reason || '';
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await performRecovery(missionId, button);
    });

    container.prepend(button);
  }

  async function decorateRow(row) {
    if (!row || decoratedRows.has(row)) return;
    decoratedRows.add(row);
    const missionId = row.dataset.openMission;
    if (!missionId) return;
    const actions = row.querySelector('.mission-actions');
    await addRecoveryButton(actions, missionId);

    row.addEventListener('click', () => {
      setTimeout(async () => {
        const modal = document.querySelector('#missionDetailModal');
        if (!modal || modal.hidden) return;
        const actions = modal.querySelector('.modal-actions > div');
        await addRecoveryButton(actions, missionId);
      }, 60);
    }, true);
  }

  async function scan() {
    const rows = [...document.querySelectorAll('[data-open-mission]')];
    await Promise.all(rows.map(decorateRow));

    // Replace legacy generic Retry buttons with the canonical recovery action
    // only when the Mission is recoverable. Capture phase prevents the old
    // retry handler from running.
    for (const button of document.querySelectorAll('.retry-button')) {
      if (button.dataset.recoveryIntercepted === 'true') continue;
      const missionId = button.dataset.missionId;
      if (!missionId) continue;
      const status = await recoveryStatus(missionId);
      if (!status?.recoverable) continue;

      button.dataset.recoveryIntercepted = 'true';
      button.textContent = status.action_label || 'Recover Mission';
      button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        await performRecovery(missionId, button);
      }, true);
    }
  }

  const observer = new MutationObserver(() => {
    void scan();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  void scan();
})(); 
