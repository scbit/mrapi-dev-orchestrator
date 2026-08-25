const { TenantsRepository } = require('./tenants.repository');
const { WorkspacesRepository } = require('./workspaces.repository');
const { ProjectsRepository } = require('./projects.repository');
const { RoadmapsRepository } = require('./roadmaps.repository');
const { WorkersRepository } = require('./workers.repository');
const { WorkerProfilesRepository } = require('./workerProfiles.repository');
const { MissionsRepository } = require('./missions.repository');
const { TasksRepository } = require('./tasks.repository');
const { RunsRepository } = require('./runs.repository');
const { ExecutorsRepository } = require('./executors.repository');
const { EvidenceRepository } = require('./evidence.repository');
const { ResultsRepository } = require('./results.repository');
const { EventsRepository } = require('./events.repository');

function createRepositories(db) {
  return {
    tenants: new TenantsRepository(db),
    workspaces: new WorkspacesRepository(db),
    projects: new ProjectsRepository(db),
    roadmaps: new RoadmapsRepository(db),
    workers: new WorkersRepository(db),
    workerProfiles: new WorkerProfilesRepository(db),
    missions: new MissionsRepository(db),
    tasks: new TasksRepository(db),
    runs: new RunsRepository(db),
    executors: new ExecutorsRepository(db),
    evidence: new EvidenceRepository(db),
    results: new ResultsRepository(db),
    events: new EventsRepository(db)
  };
}

module.exports = { createRepositories };
