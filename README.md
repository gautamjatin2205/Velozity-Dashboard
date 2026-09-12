# Orbit Project Dashboard

React + TypeScript + Vite frontend with a Node.js + Express + Prisma API, PostgreSQL persistence, and `ws` WebSockets for the role-aware live feed.

## Local setup

### Docker PostgreSQL (preferred)

1. Install Docker Desktop.
2. Start PostgreSQL on the port used by the example environment:

	```bash
	docker run --name orbit-postgres \
	  -e POSTGRES_USER=orbit \
	  -e POSTGRES_PASSWORD=orbit-local-password \
	  -e POSTGRES_DB=orbit_dashboard \
	  -p 5433:5432 -d postgres:16
	```

3. Install dependencies:

	```bash
	npm install
	cd server && npm install
	copy .env.example .env
	```

4. Set `DATABASE_URL` in `server/.env` to `postgresql://orbit:orbit-local-password@127.0.0.1:5433/orbit_dashboard`. Set strong values for `ACCESS_TOKEN_SECRET` and `REFRESH_TOKEN_SECRET`, and set `SEED_DEMO_PASSWORD` for seeded accounts.
5. From `server/`, run `npm run db:generate`, `npm run db:migrate`, and `npm run db:seed`.
6. Run `npm run dev` in `server/`, then run `npm run dev` from the repository root. The API is at `http://localhost:4000` and the frontend is at `http://localhost:5173`.

For a non-Docker PostgreSQL installation, create a database named `orbit_dashboard` and use the same `DATABASE_URL` format.

The seed creates 1 Admin, 2 Project Managers, 4 Developers, 3 projects, 15 tasks across multiple statuses, overdue tasks with past due dates, and pre-existing activity entries. It is intended for a fresh database.

## Manual deployment

Vercel should host the Vite frontend only. The Express API owns a persistent WebSocket server and must run on a long-lived Node.js host such as Render, Railway, Fly.io, or a VM. Vercel serverless functions are not suitable for this WebSocket implementation.

1. Create a managed PostgreSQL database and copy its connection string.
2. Deploy the `server/` directory to a Node.js host. Use `npm install`, `npm run db:generate`, `npm run db:migrate`, `npm run db:seed`, and `npm start`. Set `PORT` from the host, `NODE_ENV=production`, `DATABASE_URL`, strong `ACCESS_TOKEN_SECRET`, strong `REFRESH_TOKEN_SECRET`, `SEED_DEMO_PASSWORD`, and `CLIENT_ORIGIN` to the final Vercel URL. The API must expose `/health` and support WebSocket upgrades at `/ws`.
3. In Vercel, import the repository and set the project root to the repository root. Use `npm run build` as the build command and leave the output directory as `dist`.
4. Add these Vercel environment variables before deploying:

	```text
	VITE_API_URL=https://your-api-host.example.com
	VITE_WS_URL=wss://your-api-host.example.com
	```

5. Deploy the Vercel project, copy its production URL into the API host's `CLIENT_ORIGIN`, and redeploy the API if necessary. Confirm `GET https://your-api-host.example.com/health` returns `{ "ok": true }`.
6. Open the Vercel URL, log in with a seeded account, and verify refresh, logout, task updates, notifications, and live activity. Use HTTPS for both services; the production refresh cookie requires `SameSite=None; Secure`.

The frontend defaults to `http://localhost:4000` and `ws://localhost:4000` when the Vercel variables are absent, so local development continues to work.

##Live URL - https://velozity-dashboard-zitu.vercel.app/

## Project structure

```text
.
├── src/                         # React + TypeScript frontend
│   ├── App.tsx                  # Dashboard UI, auth flow, filters, and WebSocket client
│   ├── App.css                  # Dashboard and login styles
│   ├── index.css                # Global styles
│   └── main.tsx                 # React entry point
├── public/                      # Static frontend assets
├── server/
│   ├── src/index.ts             # Express API, authentication, WebSocket server, and scheduler
│   ├── prisma/
│   │   ├── schema.prisma        # PostgreSQL relational schema and indexes
│   │   ├── seed.ts              # Required demo users, projects, tasks, and activity
│   │   └── migrations/          # Versioned database migrations
│   ├── .env.example             # Server environment variable template
│   ├── package.json             # API, Prisma, and database scripts
│   └── tsconfig.json            # Server TypeScript configuration
├── index.html                   # Vite HTML entry point
├── package.json                 # Frontend scripts and dependencies
├── vite.config.ts               # Vite configuration
├── tsconfig*.json               # TypeScript configurations
└── README.md                    # Setup, architecture, schema, and limitations
```

## Database schema

```mermaid
erDiagram
	 USER ||--o{ PROJECT : owns
	 USER ||--o{ TASK : assigned
	 USER ||--o{ ACTIVITY : creates
	 USER ||--o{ NOTIFICATION : receives
	 USER ||--o{ REFRESH_TOKEN : has
	 CLIENT ||--o{ PROJECT : contains
	 PROJECT ||--o{ TASK : contains
	 PROJECT ||--o{ ACTIVITY : records
	 TASK ||--o{ ACTIVITY : records
```

`User` stores the role and password hash. `Project` belongs to a `Client` and an owner, and may have a designated Developer team leader. `ProjectMember` is the join table for project team membership, preserving the selected developer names and email identities. `Task` belongs to a project and may be assigned to a developer; it stores status, priority, due date, and timestamps. `Activity` is persisted for task history and reconnect catch-up. `Notification` stores unread/read state. `RefreshToken` stores only a SHA-256 hash. Foreign keys use cascading deletes where child records cannot exist without their parent. Indexes cover project ownership, project membership, task filtering by project/status/priority/due date, developer assignments, and activity/notification timelines.

## Architecture decisions

- **HTTP API:** Express with TypeScript, Prisma, and PostgreSQL. Zod validates every request body and query filter; errors use `{ "error": { "message": "...", "status": 400 } }`.
- **WebSockets:** Native `ws` keeps the transport small and explicit. Clients subscribe to project rooms; the server rechecks role and ownership before accepting subscriptions and before broadcasting. Activity is written before broadcast, and the API returns the latest 20 persisted events after reconnect.
- **Authentication:** Short-lived access JWTs are returned to the client. Refresh JWTs are stored only in an HttpOnly cookie and their SHA-256 hashes are stored in PostgreSQL. Protected routes load the current user from the database, so modified role claims cannot grant access.
- **Background job:** `node-cron` runs the overdue scan every minute. BullMQ + Redis would be preferable for retries and multiple API instances in production.
- **Role scope:** Admins see all data; Project Managers see only projects they own; Developers see only assigned tasks and their related activity.

## API

`POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/refresh`, `POST /api/auth/logout`, `GET/POST /api/users`, `GET/POST /api/clients`, `GET/POST/PATCH/DELETE /api/projects`, `POST /api/projects/:projectId/tasks`, `GET /api/tasks?status=&priority=&from=&to=`, `PATCH /api/tasks/:id`, `PATCH /api/tasks/:id/status`, `GET /api/activity`, `GET /api/notifications`, `PATCH /api/notifications/:id/read`, `POST /api/notifications/read-all`, `GET /api/dashboard/summary`, and `GET /ws?token=<access-token>`.

Self-registration supports Developer, Project Manager, and Admin accounts. In a production deployment, public privileged-role registration should be protected by an invitation or approval workflow.

## Known limitations

- `node-cron` is process-local; production horizontal scaling should move overdue processing to BullMQ + Redis.
- The repository includes Docker setup instructions but not a committed `docker-compose.yml`.
- Automated end-to-end tests for multi-role WebSocket isolation are not included yet.
- Client and user management currently focuses on creation/listing rather than a complete administrative edit/delete workflow.
- Deployment, public repository hosting, and Vercel configuration are environment-specific and are not committed here.

## Explanation

The hardest problem was building a live activity feed without leaking project data across roles. A browser-side filter is not sufficient because a Developer could call the API directly or subscribe to another project. Every protected route authenticates the access token, reloads the user role from PostgreSQL, and applies project ownership or task-assignment checks. For status changes, the API updates the task and writes its activity record in one database transaction. Only after that transaction succeeds does the `ws` server broadcast the event. Each connection is also checked again at broadcast time, so Admins receive the global feed, Project Managers receive activity from projects they own, and Developers receive activity for assigned tasks. On reconnect, the client requests the latest 20 activity records from PostgreSQL, which covers events missed while offline instead of relying on in-memory state. I chose native `ws` because this internal dashboard needs a small, explicit protocol rather than Socket.io features. If I continued the project, I would add multi-client end-to-end tests and move overdue processing to BullMQ with Redis for retries and horizontal scaling.
