import 'dotenv/config'
import { PrismaClient, Priority, Role, TaskStatus } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()
const users = [
  ['Alex Smith', 'admin@velozity.dev', Role.ADMIN],
  ['Priya Shah', 'priya@velozity.dev', Role.PROJECT_MANAGER],
  ['Marcus Lee', 'marcus@velozity.dev', Role.PROJECT_MANAGER],
  ['Ravi Menon', 'ravi@velozity.dev', Role.DEVELOPER],
  ['Maya Chen', 'maya@velozity.dev', Role.DEVELOPER],
  ['Lena Ortiz', 'lena@velozity.dev', Role.DEVELOPER],
  ['Jordan Bell', 'jordan@velozity.dev', Role.DEVELOPER],
] as const

async function main() {
  const demoPassword = process.env.SEED_DEMO_PASSWORD
  if (!demoPassword) throw new Error('SEED_DEMO_PASSWORD must be set in server/.env before seeding')
  const passwordHash = await bcrypt.hash(demoPassword, 12)
  const createdUsers = Object.fromEntries(await Promise.all(users.map(async ([name, email, role]) => [email, await prisma.user.create({ data: { name, email, role, passwordHash } })])))
  const clientNames = ['Acme Inc.', 'Northwind Co.', 'Canvas Studio']
  const clients = await Promise.all(clientNames.map((name) => prisma.client.create({ data: { name } })))
  const developerIds = ['ravi@velozity.dev', 'maya@velozity.dev', 'lena@velozity.dev', 'jordan@velozity.dev']
  const projects = await Promise.all(['Atlas Mobile App', 'Northstar Rebrand', 'Canvas Campaign'].map((name, index) => { const team = developerIds.slice(index % developerIds.length).concat(developerIds.slice(0, index % developerIds.length)).slice(0, 3); return prisma.project.create({ data: { name, clientId: clients[index].id, ownerId: index === 0 ? createdUsers['priya@velozity.dev'].id : createdUsers['marcus@velozity.dev'].id, teamLeaderId: createdUsers[team[0]].id, teamMembers: { create: team.map((email) => ({ userId: createdUsers[email].id })) } } }) }))
  const statuses = [TaskStatus.TODO, TaskStatus.IN_PROGRESS, TaskStatus.IN_REVIEW, TaskStatus.DONE, TaskStatus.OVERDUE]
  for (const [projectIndex, project] of projects.entries()) {
    for (let index = 0; index < 5; index++) {
      const dueDate = index === 4 ? new Date(Date.now() - 2 * 86400000) : new Date(Date.now() + (index - 2) * 86400000)
      const task = await prisma.task.create({ data: { title: `${['Finalize onboarding flow', 'Add export action', 'Accessibility audit', 'Configure analytics events', 'Prepare campaign assets'][index]} ${projectIndex + 1}`, projectId: project.id, assigneeId: createdUsers[developerIds[index % developerIds.length]].id, status: statuses[index], priority: [Priority.HIGH, Priority.MEDIUM, Priority.CRITICAL, Priority.LOW, Priority.HIGH][index], dueDate } })
      await prisma.activity.create({ data: { action: `created Task #${task.id}`, actorId: createdUsers['priya@velozity.dev'].id, projectId: project.id, taskId: task.id } })
    }
  }
}

main().finally(() => prisma.$disconnect())
