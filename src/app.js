const path = require('path');
const express = require('express');
const { getFirestore } = require('./services/firestore');
const { createRepositories } = require('./repositories');
const { tenantMiddleware } = require('./middleware/tenant');
const { createHealthRouter } = require('./routes/health.routes');
const { createDashboardRouter } = require('./routes/dashboard.routes');
const { createWorkersRouter } = require('./routes/workers.routes');
const { createWorkspacesRouter } = require('./routes/workspaces.routes');
const { createProjectsRouter } = require('./routes/projects.routes');
const { createRoadmapsRouter } = require('./routes/roadmaps.routes');
const { createMissionsRouter } = require('./routes/missions.routes');
const { createTasksRouter } = require('./routes/tasks.routes');
const { createRunnerRouter } = require('./routes/runner.routes');
const { createExecutorsRouter } = require('./routes/executors.routes');
const { createRunsRouter } = require('./routes/runs.routes');
const { createBrainRouter } = require('./routes/brain.routes');
const { createResultsRouter } = require('./routes/results.routes');
const { createEvidenceRouter } = require('./routes/evidence.routes');
const { createPlannerRouter } = require('./routes/planner.routes');
const { createPlannerUiRouter } = require('./routes/planner.ui.routes');
const { createMissionNotificationSweep } = require('./services/telegramNotifications');

function createApp(options = {}) {
  const app = express();
  const db = options.db || getFirestore();
  const repos = options.repos || createRepositories(db);
  const notificationSweep = createMissionNotificationSweep(db);

  app.disable('x-powered-by');
  app.use(express.json({ limit: '14mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(tenantMiddleware);

  // Cloud Run-safe Telegram notifications:
  // run after request completion instead of using a resident Firestore listener.
  app.use((req, res, next) => {
    res.on('finish', () => {
      if (req.method === 'OPTIONS') return;
      void notificationSweep().catch((error) => {
        console.error('[MRAPI TELEGRAM SWEEP ERROR]', String(error?.message || error).slice(0, 1000));
      });
    });
    next();
  });

  app.use('/health', createHealthRouter({ db }));
  app.use('/api/dashboard', createDashboardRouter({ db, repos }));
  app.use('/api/workers', createWorkersRouter({ repos }));
  app.use('/api/workspaces', createWorkspacesRouter({ repos }));
  app.use('/api/projects', createProjectsRouter({ repos }));
  app.use('/api/roadmaps', createRoadmapsRouter({ repos, db }));
  app.use('/api/missions', createMissionsRouter({ repos }));
  app.use('/api/tasks', createTasksRouter({ repos }));
  app.use('/api/executors', createExecutorsRouter({ repos }));
  app.use('/api/runs', createRunsRouter({ repos }));
  app.use('/api/results', createResultsRouter({ repos }));
  app.use('/api/evidence', createEvidenceRouter({ repos }));
  app.use('/api/planner', createPlannerRouter({ db, repos }));
  app.use('/api/runner', createRunnerRouter({ db }));
  app.use('/api/brain', createBrainRouter({ db }));
  app.use(createPlannerUiRouter());

  app.use(express.static(path.join(__dirname, 'public')));

  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  app.use((error, _req, res, _next) => {
    console.error('[MRAPI ERROR]', error);
    res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      message: process.env.NODE_ENV === 'production'
        ? 'Unexpected server error.'
        : error.message
    });
  });

  return app;
}

module.exports = { createApp };
