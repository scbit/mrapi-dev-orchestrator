const { TenantsRepository } = require('./tenants.repository');
const { WorkspacesRepository } = require('./workspaces.repository');
const { ProjectsRepository } = require('./projects.repository');
const { WorkersRepository } = require('./workers.repository');
const { WorkerProfilesRepository } = require('./workerProfiles.repository');
const { MissionsRepository } = require('./missions.repository');
const { TasksRepository } = require('./tasks.repository');

function createRepositories(db) {
  return {
    tenants: new TenantsRepository(db),
    workspaces: new WorkspacesRepository(db),
    projects: new ProjectsRepository(db),
    workers: new WorkersRepository(db),
    workerProfiles: new WorkerProfilesRepository(db),
    missions: new MissionsRepository(db),
    tasks: new TasksRepository(db)
  };
}

module.exports = { createRepositories };
