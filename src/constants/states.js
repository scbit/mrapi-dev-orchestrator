const WORKER_STATES = Object.freeze([
  'IDLE',
  'BUSY',
  'WAITING',
  'BLOCKED',
  'DRAINING',
  'STOPPED',
  'OFFLINE'
]);

const MISSION_STATES = Object.freeze([
  'DRAFT',
  'READY',
  'PLANNING',
  'RUNNING',
  'NEED_HUMAN_ACTION',
  'BLOCKED',
  'COMPLETED',
  'FAILED',
  'CANCELLED'
]);

const TASK_STATES = Object.freeze([
  'QUEUED',
  'ASSIGNED',
  'RUNNING',
  'TESTING',
  'WAITING',
  'BLOCKED',
  'DONE',
  'FAILED',
  'SKIPPED'
]);

const SYSTEM_STATES = Object.freeze([
  'RUNNING',
  'DRAINING',
  'STOPPED'
]);

module.exports = {
  WORKER_STATES,
  MISSION_STATES,
  TASK_STATES,
  SYSTEM_STATES
};
