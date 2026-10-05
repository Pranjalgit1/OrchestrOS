# Repository Guidelines

## Project Structure & Module Organization

OrchestrOS is an npm workspace with an Express backend, React/Vite dashboard, MySQL persistence, and Docker workload execution.

- `backend/src/modules/`: feature modules for jobs, workloads, scheduling, placement, resources, executions, monitoring, and orchestration. Keep routes, Zod schemas, services, repositories, and tests together.
- `backend/prisma/`: database schema, committed SQL migrations, and seed script.
- `frontend/src/`: React screens, reusable `components/`, API helpers, and `styles.css`.
- `workload-runner/`: container program (`run.js`) and Dockerfile.
- `docs/`: API, architecture, operating instructions, and reference images.

## Build, Test, and Development Commands

Use Node.js 22.12+ and npm 10+. Run commands from the repository root.

- `npm ci`: install locked workspace dependencies.
- `npm run prisma:generate`: generate the Prisma client.
- `npm run db:setup`: deploy migrations, create missing study workers, and apply built-in budgets to idle defaults.
- `npm run dev:backend` and `npm run dev:frontend`: start development servers in separate terminals; dashboard runs at `http://localhost:5173`.
- `npm run docker:images`: rebuild the workload image after runner changes.
- `npm run build`: check backend JavaScript syntax and build the frontend.
- `npm test`: run backend tests sequentially, then frontend polling tests.
- `npm run prisma:validate`: validate the database schema.

## Coding Style & Naming Conventions

Use JavaScript ES modules, two-space indentation, double quotes, and semicolons. Use PascalCase for React components (`JobQueue.jsx`), camelCase for functions, and uppercase constants. Follow backend names such as `workload.service.js` and `workload.repository.js`.

No formatter or linter is configured; match nearby code. `npm run check` performs syntax checks. Keep orchestration decisions in backend services and database operations in repositories; the frontend requests actions and renders actual state. Preserve conditional job claims and transactional resource accounting.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict`. Name unit tests `*.test.js` and database/container tests `*.integration.test.js`, beside their feature. No coverage threshold is configured; verify changed behavior and relevant failure paths.

Database tests require a separate MySQL database, `DATABASE_URL`, and `RUN_DATABASE_TESTS=true`. Container tests additionally require Docker and `RUN_DOCKER_TESTS=true`. See `docs/running.md`; cleanup tests can delete records globally.

## Commit & Pull Request Guidelines

History uses descriptive subjects without a consistent prefix convention. Prefer concise imperative messages, such as `Add generated workload cleanup`.

Describe the problem, resulting behavior, and validation in each PR. Link relevant issues, include screenshots for UI changes, and update API/flow documentation when behavior changes.

## Security & Configuration

Keep credentials in ignored `.env` files. Use `.env.example` for configuration names. Commit migrations and `package-lock.json`; exclude dependencies and generated build output.
