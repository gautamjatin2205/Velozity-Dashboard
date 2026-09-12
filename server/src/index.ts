import 'dotenv/config'
import crypto from 'node:crypto'
import http from 'node:http'
import express, { NextFunction, Request, Response } from 'express'
import cors from 'cors'
import jwt from 'jsonwebtoken'
import { WebSocketServer, WebSocket } from 'ws'
import { PrismaClient, Priority, Role, TaskStatus } from '@prisma/client'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import cron from 'node-cron'

const prisma = new PrismaClient()
const app = express()
const server = http.createServer(app)
type SocketConnection = { socket: WebSocket; projects: Set<string> }
const sockets = new Map<string, Set<SocketConnection>>()
const accessSecret = process.env.ACCESS_TOKEN_SECRET
const refreshSecret = process.env.REFRESH_TOKEN_SECRET
if (!accessSecret || !refreshSecret) throw new Error('ACCESS_TOKEN_SECRET and REFRESH_TOKEN_SECRET must be set in server/.env')

type Claims = { sub: string; role: Role }
declare global { namespace Express { interface Request { user?: Claims } } }
app.use(cors({ origin: process.env.CLIENT_ORIGIN, credentials: true }))
app.use(express.json())
const fail = (res: Response, status: number, message: string) => res.status(status).json({ error: { message, status } })
const auth = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const claims = jwt.verify(req.headers.authorization?.replace('Bearer ', '') ?? '', accessSecret) as Claims
    const user = await prisma.user.findUnique({ where: { id: claims.sub }, select: { id: true, role: true } })
    if (!user) return fail(res, 401, 'Authentication required')
    req.user = { sub: user.id, role: user.role }
    next()
  } catch { fail(res, 401, 'Authentication required') }
}
const allow = (...roles: Role[]) => (req: Request, res: Response, next: NextFunction) => req.user && roles.includes(req.user.role) ? next() : fail(res, 403, 'You do not have permission for this action')
const access = (user: Claims) => jwt.sign({ sub: user.sub, role: user.role }, accessSecret, { expiresIn: '15m' })
const refreshFrom = (req: Request) => req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('refreshToken='))?.slice('refreshToken='.length)
const idParam = (value: string | string[]) => Array.isArray(value) ? value[0] : value
const projectAccess = async (projectId: string, user: Claims) => {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, ownerId: true } })
  return project && (user.role === Role.ADMIN || (user.role === Role.PROJECT_MANAGER && project.ownerId === user.sub)) ? project : null
}
const canViewProject = async (projectId: string, user: Claims) => {
  if (user.role === Role.ADMIN) return true
  if (user.role === Role.PROJECT_MANAGER) return Boolean(await prisma.project.findFirst({ where: { id: projectId, ownerId: user.sub }, select: { id: true } }))
  return Boolean(await prisma.project.findFirst({ where: { id: projectId, tasks: { some: { assigneeId: user.sub } } }, select: { id: true } }))
}
function sendPresence() { const event = JSON.stringify({ type: 'presence.updated', online: sockets.size }); for (const connections of sockets.values()) for (const connection of connections) if (connection.socket.readyState === WebSocket.OPEN) connection.socket.send(event) }
function sendUserEvent(userId: string, event: unknown) { const connections = sockets.get(userId); if (!connections) return; const payload = JSON.stringify(event); for (const connection of connections) if (connection.socket.readyState === WebSocket.OPEN) connection.socket.send(payload) }

app.get('/health', (_req, res) => res.json({ ok: true }))
app.post('/api/auth/register', async (req, res) => {
  const input = z.object({ name: z.string().trim().min(2), email: z.string().email(), password: z.string().min(8), role: z.nativeEnum(Role).default(Role.DEVELOPER) }).safeParse(req.body)
  if (!input.success) return fail(res, 400, 'Name, email, and a password of at least 8 characters are required')
  if (await prisma.user.findUnique({ where: { email: input.data.email } })) return fail(res, 409, 'An account with this email already exists')
  const user = await prisma.user.create({ data: { name: input.data.name, email: input.data.email, passwordHash: await bcrypt.hash(input.data.password, 12), role: input.data.role }, select: { id: true, name: true, email: true, role: true } })
  res.status(201).json(user)
})
app.post('/api/auth/login', async (req, res) => {
  const input = z.object({ email: z.string().email(), password: z.string().min(8), expectedRole: z.nativeEnum(Role).optional() }).safeParse(req.body)
  if (!input.success) return fail(res, 400, 'Email and password are required')
  const user = await prisma.user.findUnique({ where: { email: input.data.email } })
  if (!user || (input.data.expectedRole && user.role !== input.data.expectedRole) || !(await bcrypt.compare(input.data.password, user.passwordHash))) return fail(res, 401, 'Invalid credentials')
  const claims = { sub: user.id, role: user.role }
  const refresh = jwt.sign(claims, refreshSecret, { expiresIn: '7d' })
  await prisma.refreshToken.create({ data: { tokenHash: crypto.createHash('sha256').update(refresh).digest('hex'), userId: user.id, expiresAt: new Date(Date.now() + 604800000) } })
  res.cookie('refreshToken', refresh, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', maxAge: 604800000 })
  res.json({ accessToken: access(claims), user: { id: user.id, name: user.name, role: user.role } })
})
app.post('/api/auth/refresh', async (req, res) => {
  try {
    const token = refreshFrom(req)
    const claims = jwt.verify(token ?? '', refreshSecret) as Claims
    const tokenHash = crypto.createHash('sha256').update(token!).digest('hex')
    const stored = await prisma.refreshToken.findFirst({ where: { tokenHash, userId: claims.sub, expiresAt: { gt: new Date() } }, include: { user: { select: { id: true, name: true, email: true, role: true } } } })
    if (!stored) return fail(res, 401, 'Refresh token is invalid or expired')
    res.json({ accessToken: access({ sub: stored.user.id, role: stored.user.role }), user: stored.user })
  } catch { fail(res, 401, 'Refresh token is invalid or expired') }
})
app.post('/api/auth/logout', auth, async (req, res) => {
  const token = refreshFrom(req)
  if (token) await prisma.refreshToken.deleteMany({ where: { tokenHash: crypto.createHash('sha256').update(token).digest('hex'), userId: req.user!.sub } })
  res.clearCookie('refreshToken', { httpOnly: true, sameSite: 'lax' })
  res.status(204).send()
})
app.get('/api/users', auth, allow(Role.ADMIN, Role.PROJECT_MANAGER), async (req, res) => {
  const users = await prisma.user.findMany({ where: req.user!.role === Role.PROJECT_MANAGER ? { role: Role.DEVELOPER } : {}, select: { id: true, name: true, email: true, role: true, createdAt: true }, orderBy: { name: 'asc' } })
  res.json(users)
})
app.post('/api/users', auth, allow(Role.ADMIN), async (req, res) => {
  const input = z.object({ name: z.string().trim().min(2), email: z.string().email(), password: z.string().min(8), role: z.nativeEnum(Role) }).safeParse(req.body)
  if (!input.success) return fail(res, 400, 'Name, email, password, and role are required')
  const user = await prisma.user.create({ data: { name: input.data.name, email: input.data.email, passwordHash: await bcrypt.hash(input.data.password, 12), role: input.data.role }, select: { id: true, name: true, email: true, role: true } })
  res.status(201).json(user)
})
app.get('/api/clients', auth, allow(Role.ADMIN, Role.PROJECT_MANAGER), async (_req, res) => res.json(await prisma.client.findMany({ include: { _count: { select: { projects: true } } }, orderBy: { name: 'asc' } })))
app.post('/api/clients', auth, allow(Role.ADMIN), async (req, res) => {
  const input = z.object({ name: z.string().trim().min(2) }).safeParse(req.body)
  if (!input.success) return fail(res, 400, 'Client name is required')
  res.status(201).json(await prisma.client.create({ data: { name: input.data.name } }))
})
app.get('/api/projects', auth, allow(Role.ADMIN, Role.PROJECT_MANAGER, Role.DEVELOPER), async (req, res) => {
  const where = req.user!.role === Role.ADMIN ? {} : req.user!.role === Role.PROJECT_MANAGER ? { ownerId: req.user!.sub } : { tasks: { some: { assigneeId: req.user!.sub } } }
  res.json(await prisma.project.findMany({ where, include: { client: true, owner: { select: { id: true, name: true } }, teamLeader: { select: { id: true, name: true, email: true } }, teamMembers: { include: { user: { select: { id: true, name: true, email: true } } } }, _count: { select: { tasks: true } } }, orderBy: { createdAt: 'desc' } }))
})
app.post('/api/projects', auth, allow(Role.ADMIN, Role.PROJECT_MANAGER), async (req, res) => {
  const input = z.object({ name: z.string().trim().min(2), clientId: z.string().min(1), description: z.string().trim().max(5000).optional(), teamMemberIds: z.array(z.string().min(1)).min(1), teamLeaderId: z.string().min(1) }).safeParse(req.body)
  if (!input.success) return fail(res, 400, 'Project name, client, team members, and team leader are required')
  const client = await prisma.client.findUnique({ where: { id: input.data.clientId } })
  if (!client) return fail(res, 404, 'Client not found')
  const memberIds = [...new Set(input.data.teamMemberIds)]
  if (!memberIds.includes(input.data.teamLeaderId)) return fail(res, 400, 'The team leader must be selected as a team member')
  const members = await prisma.user.findMany({ where: { id: { in: memberIds }, role: Role.DEVELOPER }, select: { id: true } })
  if (members.length !== memberIds.length) return fail(res, 400, 'Team members and the team leader must be Developers')
  res.status(201).json(await prisma.project.create({ data: { name: input.data.name, description: input.data.description, clientId: client.id, ownerId: req.user!.sub, teamLeaderId: input.data.teamLeaderId, teamMembers: { create: memberIds.map((userId) => ({ userId })) } }, include: { client: true, teamLeader: { select: { id: true, name: true, email: true } }, teamMembers: { include: { user: { select: { id: true, name: true, email: true } } } } } }))
})
app.patch('/api/projects/:projectId', auth, allow(Role.ADMIN, Role.PROJECT_MANAGER), async (req, res) => {
  const projectId = idParam(req.params.projectId)
  if (!(await projectAccess(projectId, req.user!))) return fail(res, 404, 'Project not found')
  const input = z.object({ name: z.string().trim().min(2).optional(), clientId: z.string().min(1).optional(), description: z.string().trim().max(5000).optional(), teamMemberIds: z.array(z.string().min(1)).min(1).optional(), teamLeaderId: z.string().min(1).optional() }).refine((value) => value.name || value.clientId || value.description || value.teamMemberIds || value.teamLeaderId, 'At least one project field is required').safeParse(req.body)
  if (!input.success) return fail(res, 400, 'Provide valid project and team fields')
  if (input.data.clientId && !(await prisma.client.findUnique({ where: { id: input.data.clientId } }))) return fail(res, 404, 'Client not found')
  if (input.data.teamMemberIds || input.data.teamLeaderId) {
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { teamLeaderId: true, teamMembers: { select: { userId: true } } } })
    const memberIds = [...new Set(input.data.teamMemberIds ?? project?.teamMembers.map((member) => member.userId) ?? [])]
    const leaderId = input.data.teamLeaderId ?? project?.teamLeaderId
    if (!leaderId || !memberIds.includes(leaderId)) return fail(res, 400, 'The team leader must be selected as a team member')
    const members = await prisma.user.findMany({ where: { id: { in: memberIds }, role: Role.DEVELOPER }, select: { id: true } })
    if (members.length !== memberIds.length) return fail(res, 400, 'Team members and the team leader must be Developers')
    const projectFields = { ...(input.data.name !== undefined && { name: input.data.name }), ...(input.data.clientId !== undefined && { clientId: input.data.clientId }), ...(input.data.description !== undefined && { description: input.data.description }) }
    const updated = await prisma.$transaction(async (tx) => { await tx.projectMember.deleteMany({ where: { projectId } }); return tx.project.update({ where: { id: projectId }, data: { ...projectFields, teamLeaderId: leaderId, teamMembers: { create: memberIds.map((userId) => ({ userId })) } }, include: { client: true, teamLeader: { select: { id: true, name: true, email: true } }, teamMembers: { include: { user: { select: { id: true, name: true, email: true } } } } } }) })
    return res.json(updated)
  }
  res.json(await prisma.project.update({ where: { id: projectId }, data: input.data, include: { client: true, teamLeader: { select: { id: true, name: true, email: true } }, teamMembers: { include: { user: { select: { id: true, name: true, email: true } } } } } }))
})
app.delete('/api/projects/:projectId', auth, allow(Role.ADMIN, Role.PROJECT_MANAGER), async (req, res) => {
  const projectId = idParam(req.params.projectId)
  if (!(await projectAccess(projectId, req.user!))) return fail(res, 404, 'Project not found')
  await prisma.project.delete({ where: { id: projectId } })
  res.status(204).send()
})
app.post('/api/projects/:projectId/tasks', auth, allow(Role.ADMIN, Role.PROJECT_MANAGER), async (req, res) => {
  const projectId = idParam(req.params.projectId)
  if (!(await projectAccess(projectId, req.user!))) return fail(res, 404, 'Project not found')
  const input = z.object({ title: z.string().trim().min(2), description: z.string().optional(), assigneeId: z.string().min(1).optional(), priority: z.nativeEnum(Priority).default(Priority.MEDIUM), dueDate: z.coerce.date().optional() }).safeParse(req.body)
  if (!input.success) return fail(res, 400, 'Task title and valid task fields are required')
  if (input.data.assigneeId) { const assignee = await prisma.user.findFirst({ where: { id: input.data.assigneeId, role: Role.DEVELOPER } }); if (!assignee) return fail(res, 400, 'Tasks can only be assigned to developers') }
  const task = await prisma.task.create({ data: { title: input.data.title, description: input.data.description, projectId, assigneeId: input.data.assigneeId, priority: input.data.priority, dueDate: input.data.dueDate } })
  await prisma.activity.create({ data: { action: `created Task #${task.id}`, actorId: req.user!.sub, projectId, taskId: task.id } })
  if (task.assigneeId) { const notification = await prisma.notification.create({ data: { userId: task.assigneeId, message: `You were assigned ${task.title}` } }); sendUserEvent(task.assigneeId, { type: 'notification.created', notification }) }
  res.status(201).json(task)
})
app.get('/api/tasks', auth, allow(Role.ADMIN, Role.PROJECT_MANAGER, Role.DEVELOPER), async (req, res) => {
  const parsed = z.object({ status: z.nativeEnum(TaskStatus).optional(), priority: z.nativeEnum(Priority).optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() }).safeParse(req.query)
  if (!parsed.success) return fail(res, 400, 'Invalid task filters')
  const query = parsed.data
  const where = { ...(query.status && { status: query.status }), ...(query.priority && { priority: query.priority }), ...(query.from || query.to ? { dueDate: { ...(query.from && { gte: query.from }), ...(query.to && { lte: query.to }) } } : {}), ...(req.user!.role === Role.DEVELOPER ? { assigneeId: req.user!.sub } : req.user!.role === Role.PROJECT_MANAGER ? { project: { ownerId: req.user!.sub } } : {}) }
  res.json(await prisma.task.findMany({ where, include: { project: true, assignee: true }, orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }] }))
})
app.patch('/api/tasks/:id', auth, allow(Role.ADMIN, Role.PROJECT_MANAGER), async (req, res) => {
  const input = z.object({ title: z.string().trim().min(2).optional(), description: z.string().optional(), assigneeId: z.string().min(1).nullable().optional(), priority: z.nativeEnum(Priority).optional(), dueDate: z.coerce.date().nullable().optional(), status: z.nativeEnum(TaskStatus).optional() }).refine((value) => Object.keys(value).length > 0, 'At least one task field is required').safeParse(req.body)
  if (!input.success) return fail(res, 400, 'Provide at least one valid task field')
  const taskId = idParam(req.params.id)
  const task = await prisma.task.findUnique({ where: { id: taskId } })
  const project = task ? await prisma.project.findUnique({ where: { id: task.projectId }, select: { ownerId: true } }) : null
  if (!task || !project || (req.user!.role === Role.PROJECT_MANAGER && project.ownerId !== req.user!.sub)) return fail(res, 404, 'Task not found')
  if (input.data.assigneeId) { const assignee = await prisma.user.findFirst({ where: { id: input.data.assigneeId, role: Role.DEVELOPER } }); if (!assignee) return fail(res, 400, 'Tasks can only be assigned to developers') }
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.task.update({ where: { id: task.id }, data: input.data })
    await tx.activity.create({ data: { action: `edited Task #${task.id}`, actorId: req.user!.sub, projectId: task.projectId, taskId: task.id } })
    return result
  })
  if (input.data.assigneeId && input.data.assigneeId !== task.assigneeId) { const notification = await prisma.notification.create({ data: { userId: input.data.assigneeId, message: `You were assigned ${updated.title}` } }); sendUserEvent(input.data.assigneeId, { type: 'notification.created', notification }) }
  res.json(updated)
})
app.patch('/api/tasks/:id/status', auth, allow(Role.ADMIN, Role.PROJECT_MANAGER, Role.DEVELOPER), async (req, res) => {
  const input = z.object({ status: z.nativeEnum(TaskStatus) }).safeParse(req.body)
  if (!input.success) return fail(res, 400, 'A valid task status is required')
  const taskId = idParam(req.params.id)
  const task = await prisma.task.findUnique({ where: { id: taskId } })
  const project = task ? await prisma.project.findUnique({ where: { id: task.projectId }, select: { ownerId: true } }) : null
  if (!task || !project || (req.user!.role === Role.DEVELOPER && task.assigneeId !== req.user!.sub) || (req.user!.role === Role.PROJECT_MANAGER && project.ownerId !== req.user!.sub)) return fail(res, 404, 'Task not found')
  const updated = await prisma.$transaction(async (tx) => { const result = await tx.task.update({ where: { id: task.id }, data: { status: input.data.status } }); const activity = await tx.activity.create({ data: { action: `moved Task #${task.id} from ${task.status} to ${input.data.status}`, actorId: req.user!.sub, projectId: task.projectId, taskId: task.id }, include: { actor: { select: { name: true } } } }); return { result, activity } })
  if (input.data.status === TaskStatus.IN_REVIEW && task.assigneeId) { const owner = await prisma.project.findUnique({ where: { id: task.projectId }, select: { ownerId: true } }); if (owner && owner.ownerId !== task.assigneeId) { const notification = await prisma.notification.create({ data: { userId: owner.ownerId, message: `${task.title} moved to In Review` } }); sendUserEvent(owner.ownerId, { type: 'notification.created', notification }) } }
  void broadcast(task.projectId, { type: 'task.status_changed', task: updated.result, activity: updated.activity })
  res.json(updated.result)
})
app.get('/api/activity', auth, allow(Role.ADMIN, Role.PROJECT_MANAGER, Role.DEVELOPER), async (req, res) => { const activities = await prisma.activity.findMany({ where: req.user!.role === Role.ADMIN ? {} : req.user!.role === Role.DEVELOPER ? { task: { assigneeId: req.user!.sub } } : { project: { ownerId: req.user!.sub } }, include: { actor: true, task: true }, orderBy: { createdAt: 'desc' }, take: 20 }); res.json(activities) })
app.get('/api/notifications', auth, allow(Role.ADMIN, Role.PROJECT_MANAGER, Role.DEVELOPER), async (req, res) => res.json(await prisma.notification.findMany({ where: { userId: req.user!.sub }, orderBy: { createdAt: 'desc' }, take: 20 })))
app.patch('/api/notifications/:id/read', auth, allow(Role.ADMIN, Role.PROJECT_MANAGER, Role.DEVELOPER), async (req, res) => { const id = idParam(req.params.id); const notification = await prisma.notification.updateMany({ where: { id, userId: req.user!.sub }, data: { readAt: new Date() } }); if (!notification.count) return fail(res, 404, 'Notification not found'); res.status(204).send() })
app.post('/api/notifications/read-all', auth, allow(Role.ADMIN, Role.PROJECT_MANAGER, Role.DEVELOPER), async (req, res) => { await prisma.notification.updateMany({ where: { userId: req.user!.sub, readAt: null }, data: { readAt: new Date() } }); res.status(204).send() })
app.get('/api/dashboard/summary', auth, allow(Role.ADMIN, Role.PROJECT_MANAGER, Role.DEVELOPER), async (req, res) => {
  const taskWhere = req.user!.role === Role.ADMIN ? {} : req.user!.role === Role.PROJECT_MANAGER ? { project: { ownerId: req.user!.sub } } : { assigneeId: req.user!.sub }
  const weekEnd = new Date(); weekEnd.setDate(weekEnd.getDate() + (7 - weekEnd.getDay())); weekEnd.setHours(23, 59, 59, 999)
  const [projects, tasks, priorities, upcomingDue, overdue, unread] = await Promise.all([prisma.project.count({ where: req.user!.role === Role.ADMIN ? {} : req.user!.role === Role.PROJECT_MANAGER ? { ownerId: req.user!.sub } : { tasks: { some: { assigneeId: req.user!.sub } } } }), prisma.task.groupBy({ by: ['status'], where: taskWhere, _count: true }), prisma.task.groupBy({ by: ['priority'], where: taskWhere, _count: true }), prisma.task.findMany({ where: { ...taskWhere, dueDate: { gte: new Date(), lte: weekEnd }, status: { not: TaskStatus.DONE } }, select: { id: true, title: true, dueDate: true, priority: true }, orderBy: { dueDate: 'asc' }, take: 10 }), prisma.task.count({ where: { ...taskWhere, status: TaskStatus.OVERDUE } }), prisma.notification.count({ where: { userId: req.user!.sub, readAt: null } })])
  res.json({ projects, tasks, priorities, upcomingDue, totalTasks: tasks.reduce((total, group) => total + group._count, 0), overdue, unread })
})

app.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => fail(res, 500, 'Internal server error'))

const wss = new WebSocketServer({ server, path: '/ws' })
wss.on('connection', async (socket, request) => { try { const claims = jwt.verify(new URL(request.url ?? '', 'http://localhost').searchParams.get('token') ?? '', accessSecret) as Claims; const user = await prisma.user.findUnique({ where: { id: claims.sub }, select: { id: true, role: true } }); if (!user) return socket.close(1008, 'Unauthorized'); const connection: SocketConnection = { socket, projects: new Set() }; const set = sockets.get(user.id) ?? new Set<SocketConnection>(); set.add(connection); sockets.set(user.id, set); sendPresence(); socket.on('message', async (raw) => { try { const input = z.object({ type: z.enum(['subscribe', 'unsubscribe']), projectId: z.string().min(1) }).parse(JSON.parse(raw.toString())); if (input.type === 'subscribe' && input.projectId !== '*' && !(await canViewProject(input.projectId, { sub: user.id, role: user.role }))) return socket.send(JSON.stringify({ type: 'subscription.denied', projectId: input.projectId })); input.type === 'subscribe' ? connection.projects.add(input.projectId) : connection.projects.delete(input.projectId); socket.send(JSON.stringify({ type: `subscription.${input.type}d`, projectId: input.projectId })) } catch { socket.send(JSON.stringify({ type: 'subscription.invalid' })) } }); socket.on('close', () => { set.delete(connection); if (!set.size) sockets.delete(user.id); sendPresence() }) } catch { socket.close(1008, 'Unauthorized') } })
async function broadcast(projectId: string, event: unknown) { const task = typeof event === 'object' && event !== null && 'task' in event ? (event as { task?: { assigneeId: string | null } }).task : undefined; for (const [userId, set] of sockets.entries()) { const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } }); const canSee = user?.role === Role.ADMIN || (user?.role === Role.PROJECT_MANAGER && await canViewProject(projectId, { sub: userId, role: Role.PROJECT_MANAGER })) || (user?.role === Role.DEVELOPER && task?.assigneeId === userId); for (const connection of set) if (canSee && (connection.projects.has(projectId) || connection.projects.has('*')) && connection.socket.readyState === WebSocket.OPEN) connection.socket.send(JSON.stringify({ projectId, ...event as object })) } }
async function markOverdue() { await prisma.task.updateMany({ where: { dueDate: { lt: new Date() }, status: { notIn: [TaskStatus.DONE, TaskStatus.OVERDUE] } }, data: { status: TaskStatus.OVERDUE } }) }
cron.schedule('* * * * *', () => { void markOverdue() })
server.listen(Number(process.env.PORT ?? 4000), () => console.log(`API listening on ${process.env.PORT ?? 4000}`))
