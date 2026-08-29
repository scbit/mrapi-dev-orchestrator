const fs = require('fs');

const file = 'src/routes/planner.ui.routes.js';
const before = fs.readFileSync(file, 'utf8');
let s = before;

if (!s.includes('PLANNER_AUTO_METADATA_REPAIR_V1')) {
  const oldText = `        const proposal = await fetch('/api/planner/proposals/' + encodeURIComponent(proposalId)).then(parseResponse);
        let runtimeProposal = proposal;
        const roadmapId = text(proposal.roadmap_id || proposal.proposal_id || proposal.id || proposalId).trim();
`;

  const newText = `        let proposal = await fetch('/api/planner/proposals/' + encodeURIComponent(proposalId)).then(parseResponse);

        // PLANNER_AUTO_METADATA_REPAIR_V1
        // Planner Roadmaps are self-healing: if persisted review metadata was
        // destructively lost by an older Roadmap save, repair the SAME Roadmap
        // from trusted Planner Brain evidence and retry the read once.
        const needsMetadataRepair =
          text(proposal?.proposal_type).trim() === 'PLANNER_ROADMAP' &&
          (!isProposalRenderable(proposal) || !isReviewComplete(proposal));

        if (needsMetadataRepair) {
          state.metadataRepairAttempts = state.metadataRepairAttempts || {};
          const repairKey = text(proposal.roadmap_id || proposal.proposal_id || proposal.id || proposalId).trim();

          if (repairKey && !state.metadataRepairAttempts[repairKey]) {
            state.metadataRepairAttempts[repairKey] = true;
            setStatus('Planner metadata incomplete. Repairing trusted persisted proposal...', '');

            try {
              const repair = await fetch(
                '/api/planner/roadmaps/' + encodeURIComponent(repairKey) + '/repair-metadata',
                {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({})
                }
              ).then(parseResponse);

              proposal = await fetch(
                '/api/planner/proposals/' + encodeURIComponent(repairKey)
              ).then(parseResponse);

              if (isProposalRenderable(proposal) && isReviewComplete(proposal)) {
                setStatus(
                  'Planner metadata repaired automatically' +
                  (repair?.source ? ' from ' + repair.source + '.' : '.'),
                  'success'
                );
              }
            } catch (repairError) {
              // Fail closed and keep the existing incomplete rendering. Never loop,
              // never create a Roadmap/Mission/Run, and never replace trusted state.
              state.metadataRepairError = repairError.message || String(repairError);
            }
          }
        }

        let runtimeProposal = proposal;
        const roadmapId = text(proposal.roadmap_id || proposal.proposal_id || proposal.id || proposalId).trim();
`;

  if (!s.includes(oldText)) {
    throw new Error('PATCH_PATTERN_NOT_FOUND:loadProposal proposal fetch');
  }
  s = s.replace(oldText, newText);
}

fs.writeFileSync(file, s, 'utf8');

const verify = fs.readFileSync(file, 'utf8');
if (!verify.includes('PLANNER_AUTO_METADATA_REPAIR_V1')) {
  throw new Error('VERIFY_FAILED:auto repair marker');
}
if (!verify.includes("'/repair-metadata'")) {
  throw new Error('VERIFY_FAILED:repair endpoint');
}
if (!verify.includes('state.metadataRepairAttempts')) {
  throw new Error('VERIFY_FAILED:loop guard');
}

console.log('PLANNER_AUTO_METADATA_REPAIR_V1_OK');
