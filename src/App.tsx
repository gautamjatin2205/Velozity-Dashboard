import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Bell, Check, ChevronDown, CircleHelp, Filter, LayoutDashboard, LogOut, Menu, MoreHorizontal, Plus, Search, Settings, ShieldCheck, Users, X, Zap } from 'lucide-react'
import './App.css'

type Role = 'Admin' | 'Project Manager' | 'Developer'
type Status = 'To Do' | 'In Progress' | 'In Review' | 'Done' | 'Overdue'
type Priority = 'Low' | 'Medium' | 'High' | 'Critical'

type Task = {
  id: string
  title: string
  description?: string
  projectId?: string
  project: string
  status: Status
  priority: Priority
  due: string
  dueDate?: string
  assignee: string
  initials: string
}
type NotificationItem = { id: string; message: string; readAt: string | null; createdAt: string }
type CurrentUser = { id: string; name: string; email: string; role: string }
type ProjectItem = { id: string; name: string; description?: string | null; client: { id?: string; name: string }; owner: { name: string }; teamLeader?: { id: string; name: string; email: string } | null; teamMembers?: Array<{ user: { id: string; name: string; email: string } }>; _count: { tasks: number } }
type TeamMember = { id: string; name: string; email: string; role: string }

const apiBaseUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4000'
const websocketUrl = import.meta.env.VITE_WS_URL ?? 'ws://localhost:4000'

const readableAction = (action: string) => action.replace(/moved (Task #[^ ]+) from ([A-Z_]+) to ([A-Z_]+)/, (_match, task, from, to) => `moved ${task} from ${from.replaceAll('_', ' ').replace('IN PROGRESS', 'In Progress').replace('IN REVIEW', 'In Review').replace('TODO', 'To Do').replace('DONE', 'Done').replace('OVERDUE', 'Overdue')} → ${to.replaceAll('_', ' ').replace('IN PROGRESS', 'In Progress').replace('IN REVIEW', 'In Review').replace('TODO', 'To Do').replace('DONE', 'Done').replace('OVERDUE', 'Overdue')}`)
const readableStatus = (status: string): Status => status.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (character) => character.toUpperCase()) as Status
const relativeTime = (timestamp: string) => { const elapsed = Math.max(0, Date.now() - new Date(timestamp).getTime()); const minutes = Math.floor(elapsed / 60000); if (minutes < 1) return 'just now'; if (minutes < 60) return `${minutes} min${minutes === 1 ? '' : 's'} ago`; const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`; const days = Math.floor(hours / 24); return `${days} day${days === 1 ? '' : 's'} ago` }
const userInitials = (name: string) => name.split(' ').filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase()

const demoActivity = [
  { name: 'Ravi Menon', action: 'moved Task #12 from In Progress to In Review', time: '2 mins ago', color: 'coral' },
  { name: 'Maya Chen', action: 'was assigned Task #18 in Atlas Mobile App', time: '18 mins ago', color: 'teal' },
  { name: 'Lena Ortiz', action: 'completed Task #31', time: '44 mins ago', color: 'lavender' },
  { name: 'Jordan Bell', action: 'added a comment to Canvas Campaign', time: '1 hr ago', color: 'yellow' },
]

function App() {
  const [accessToken, setAccessToken] = useState('')
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null)
  const [projects, setProjects] = useState<ProjectItem[]>([])
  const [team, setTeam] = useState<TeamMember[]>([])
  const [showProjectForm, setShowProjectForm] = useState(false)
  const [editingProject, setEditingProject] = useState<ProjectItem | null>(null)
  const [projectName, setProjectName] = useState('')
  const [projectRequirements, setProjectRequirements] = useState('')
  const [projectClientId, setProjectClientId] = useState('')
  const [projectTeamMemberIds, setProjectTeamMemberIds] = useState<string[]>([])
  const [draftProjectTeamMemberIds, setDraftProjectTeamMemberIds] = useState<string[]>([])
  const [projectTeamLeaderId, setProjectTeamLeaderId] = useState('')
  const [clients, setClients] = useState<Array<{ id: string; name: string }>>([])
  const [loginEmail, setLoginEmail] = useState('admin@velozity.dev')
  const [loginPassword, setLoginPassword] = useState('')
  const [registerName, setRegisterName] = useState('')
  const [registerRole, setRegisterRole] = useState<Role>('Developer')
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login')
  const [loginAsRole, setLoginAsRole] = useState<Role>('Admin')
  const [loginError, setLoginError] = useState('')
  const [tasks, setTasks] = useState<Task[]>([])
  const [activity, setActivity] = useState<Array<{ name: string; action: string; time: string; color: string }>>(demoActivity)
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const [notificationCount, setNotificationCount] = useState(0)
  const [onlineUsers, setOnlineUsers] = useState(0)
  const [summary, setSummary] = useState({ projects: 0, totalTasks: 0, inProgress: 0, overdue: 0, statuses: [] as Array<{ status: string; _count: number }>, priorities: [] as Array<{ priority: string; _count: number }>, upcomingDue: [] as Array<{ id: string; title: string; dueDate: string; priority: string }> })
  const [priorityFilter, setPriorityFilter] = useState('')
  const [dueFrom, setDueFrom] = useState('')
  const [dueTo, setDueTo] = useState('')
  const [role, setRole] = useState<Role>('Admin')
  const [activeNav, setActiveNav] = useState('Overview')
  const [statusFilter, setStatusFilter] = useState('')
  const [search, setSearch] = useState('')
  const [showNotifications, setShowNotifications] = useState(false)
  const [showProfileMenu, setShowProfileMenu] = useState(false)
  const [notice, setNotice] = useState('')
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [taskTitle, setTaskTitle] = useState('')
  const [taskDescription, setTaskDescription] = useState('')
  const [taskPriority, setTaskPriority] = useState<Priority>('Medium')
  const [taskStatus, setTaskStatus] = useState<Status>('To Do')
  const [taskDueDate, setTaskDueDate] = useState('')

  useEffect(() => {
    if (draftProjectTeamMemberIds.length) setProjectTeamMemberIds(draftProjectTeamMemberIds)
  }, [draftProjectTeamMemberIds])

  const filteredTasks = useMemo(() => tasks.filter((task) => {
    const matchesStatus = !statusFilter || task.status === statusFilter
    const matchesSearch = `${task.title} ${task.project} ${task.assignee}`.toLowerCase().includes(search.toLowerCase())
    return matchesStatus && matchesSearch
  }), [search, statusFilter, tasks])

  const api = async (path: string, options: RequestInit = {}) => {
    const response = await fetch(`${apiBaseUrl}${path}`, { ...options, credentials: 'include', headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}), ...options.headers } })
    if (response.status === 401 && path !== '/api/auth/refresh') throw new Error('Session expired')
    if (!response.ok) throw new Error((await response.json()).error?.message ?? 'Request failed')
    return response.status === 204 ? null : response.json()
  }

  const loadDashboard = async () => {
    const query = new URLSearchParams()
    if (statusFilter) query.set('status', statusFilter.toUpperCase().replaceAll(' ', '_'))
    if (priorityFilter) query.set('priority', priorityFilter.toUpperCase())
    if (dueFrom) query.set('from', dueFrom)
    if (dueTo) query.set('to', dueTo)
    const [serverTasks, serverActivity, notifications, serverSummary] = await Promise.all([api(`/api/tasks?${query}`), api('/api/activity'), api('/api/notifications'), api('/api/dashboard/summary')])
    setSummary({ projects: serverSummary.projects, totalTasks: serverSummary.totalTasks, inProgress: serverSummary.tasks.find((item: { status: string }) => item.status === 'IN_PROGRESS')?._count ?? 0, overdue: serverSummary.overdue, statuses: serverSummary.tasks, priorities: serverSummary.priorities, upcomingDue: serverSummary.upcomingDue })
    setTasks(serverTasks.map((task: { id: string; title: string; description?: string; projectId: string; project: { name: string }; status: string; priority: string; dueDate?: string; assignee?: { name: string } }) => ({ id: task.id, title: task.title, description: task.description, projectId: task.projectId, project: task.project.name, status: readableStatus(task.status), priority: task.priority[0] + task.priority.slice(1).toLowerCase() as Priority, due: task.dueDate ? new Date(task.dueDate).toLocaleDateString('en-US', { month: 'short', day: '2-digit' }) : 'No date', dueDate: task.dueDate, assignee: task.assignee?.name ?? 'Unassigned', initials: task.assignee?.name.split(' ').map((part) => part[0]).join('') ?? '--' })))
    setActivity(serverActivity.map((item: { actor: { name: string }; action: string; createdAt: string }) => ({ name: item.actor.name, action: readableAction(item.action), time: relativeTime(item.createdAt), color: 'teal' })))
    setNotifications(notifications)
    setNotificationCount(notifications.filter((item: { readAt: string | null }) => !item.readAt).length)
  }

  useEffect(() => { void api('/api/auth/refresh').then((result: { accessToken: string; user: CurrentUser }) => { setAccessToken(result.accessToken); setCurrentUser(result.user); setRole(roleLabel(result.user.role)); setLoginAsRole(roleLabel(result.user.role)) }) }, [])
  useEffect(() => {
    if (accessToken) return
    const passwordInput = document.querySelector<HTMLInputElement>('.login-card input[type="password"]')
    if (!passwordInput || !passwordInput.parentElement) return
    const field = passwordInput.parentElement
    field.style.position = 'relative'
    passwordInput.style.paddingRight = '38px'
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'password-toggle'
    toggle.setAttribute('aria-label', 'Show password')
    toggle.textContent = '\u{1F441}'
    toggle.onclick = () => {
      const visible = passwordInput.type === 'text'
      passwordInput.type = visible ? 'password' : 'text'
      toggle.setAttribute('aria-label', visible ? 'Show password' : 'Hide password')
      toggle.textContent = '\u{1F441}'
    }
    field.appendChild(toggle)
    return () => toggle.remove()
  }, [accessToken, authMode])
  useEffect(() => {
    const card = document.querySelector<HTMLElement>('.login-card')
    if (!card || accessToken || authMode !== 'login') return
    const demoAccounts: Record<Role, string> = {
      Admin: 'Demo login Admin ID: admin@velozity.dev  Demo password: Password123',
      'Project Manager': 'Demo Project Manager ID: priya@velozity.dev Demo password: Password123',
      Developer: 'Demo Developer ID: ravi@velozity.dev Demo password: Password123',
    }
    card.style.setProperty('--demo-credentials', JSON.stringify(demoAccounts[loginAsRole]))
    return () => { card.style.removeProperty('--demo-credentials') }
  }, [accessToken, authMode, loginAsRole])
  useEffect(() => { if (!accessToken) return; void loadDashboard(); const socket = new WebSocket(`${websocketUrl}/ws?token=${accessToken}`); socket.onopen = () => socket.send(JSON.stringify({ type: 'subscribe', projectId: '*' })); socket.onmessage = (event) => { const message = JSON.parse(event.data) as { type: string; online?: number; task?: Task; activity?: { actor: { name: string }; action: string; createdAt: string }; notification?: NotificationItem }; if (message.type === 'presence.updated' && typeof message.online === 'number') setOnlineUsers(message.online); if (message.type === 'notification.created' && message.notification) { setNotifications((current) => [message.notification!, ...current].slice(0, 20)); setNotificationCount((count) => count + 1) }; if (message.type === 'task.status_changed') { if (message.activity) setActivity((current) => [{ name: message.activity!.actor.name, action: readableAction(message.activity!.action), time: relativeTime(message.activity!.createdAt), color: 'coral' }, ...current].slice(0, 20)); void loadDashboard() } }; return () => socket.close() }, [accessToken, statusFilter, priorityFilter, dueFrom, dueTo])
  useEffect(() => { if (!accessToken || activeNav === 'Overview' || activeNav === 'My tasks') return; if (activeNav === 'Projects') void Promise.all([api('/api/projects'), api('/api/clients'), api('/api/users')]).then(([projectData, clientData, teamData]) => { setProjects(projectData); setClients(clientData); setTeam(teamData) }); if (activeNav === 'Team') void api('/api/users').then(setTeam) }, [accessToken, activeNav])

  const roleLabel = (serverRole: string): Role => serverRole === 'PROJECT_MANAGER' ? 'Project Manager' : serverRole === 'DEVELOPER' ? 'Developer' : 'Admin'
  const login = async (event: FormEvent) => { event.preventDefault(); setLoginError(''); try { const result = await fetch(`${apiBaseUrl}/api/auth/login`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: loginEmail, password: loginPassword, expectedRole: loginAsRole === 'Project Manager' ? 'PROJECT_MANAGER' : loginAsRole.toUpperCase() }) }); if (!result.ok) throw new Error((await result.json()).error?.message ?? 'Unable to sign in'); const data = await result.json(); const authenticatedRole = roleLabel(data.user.role); setAccessToken(data.accessToken); setCurrentUser(data.user); setRole(authenticatedRole); setLoginAsRole(authenticatedRole) } catch (error) { setLoginError(error instanceof Error ? error.message : 'Unable to sign in') } }
  const register = async (event: FormEvent) => { event.preventDefault(); setLoginError(''); try { const result = await fetch(`${apiBaseUrl}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: registerName, email: loginEmail, password: loginPassword, role: registerRole === 'Project Manager' ? 'PROJECT_MANAGER' : registerRole.toUpperCase() }) }); if (!result.ok) throw new Error((await result.json()).error?.message ?? 'Unable to create account'); setLoginAsRole(registerRole); setRole(registerRole); setAuthMode('login'); setLoginError(`${registerRole} account created. Sign in to continue.`) } catch (error) { setLoginError(error instanceof Error ? error.message : 'Unable to create account') } }
  const chooseRole = (nextRole: Role) => { setLoginAsRole(nextRole); setLoginEmail(nextRole === 'Admin' ? 'admin@velozity.dev' : nextRole === 'Project Manager' ? 'priya@velozity.dev' : 'ravi@velozity.dev') }
  const createProject = async (event: FormEvent) => { event.preventDefault(); try { await api(editingProject ? `/api/projects/${editingProject.id}` : '/api/projects', { method: editingProject ? 'PATCH' : 'POST', body: JSON.stringify({ name: projectName, clientId: projectClientId, description: projectRequirements, teamMemberIds: projectTeamMemberIds, teamLeaderId: projectTeamLeaderId }) }); setShowProjectForm(false); setEditingProject(null); setProjectName(''); setProjectClientId(''); setProjectRequirements(''); setProjectTeamMemberIds([]); setDraftProjectTeamMemberIds([]); setProjectTeamLeaderId(''); notify(editingProject ? 'Project updated successfully' : 'Project created successfully'); const data = await api('/api/projects'); setProjects(data) } catch (error) { notify(error instanceof Error ? error.message : 'Unable to save project') } }
  const openNewProject = () => { setEditingProject(null); setProjectName(''); setProjectClientId(''); setProjectRequirements(''); setProjectTeamMemberIds([]); setDraftProjectTeamMemberIds([]); setProjectTeamLeaderId(''); setShowProjectForm(true) }
  const openProjectEdit = (project: ProjectItem) => { const memberIds = project.teamMembers?.map((member) => member.user.id) ?? []; setEditingProject(project); setProjectName(project.name); setProjectClientId(project.client.id ?? ''); setProjectRequirements(project.description ?? ''); setProjectTeamMemberIds(memberIds); setDraftProjectTeamMemberIds(memberIds); setProjectTeamLeaderId(project.teamLeader?.id ?? ''); setShowProjectForm(true) }
  const openTaskEdit = (task: Task) => { setEditingTask(task); setTaskTitle(task.title); setTaskDescription(task.description ?? ''); setTaskPriority(task.priority); setTaskStatus(task.status); setTaskDueDate(task.dueDate ? task.dueDate.slice(0, 10) : '') }
  const updateTask = async (event: FormEvent) => { event.preventDefault(); if (!editingTask) return; try { await api(`/api/tasks/${editingTask.id}`, { method: 'PATCH', body: JSON.stringify({ title: taskTitle, description: taskDescription, priority: taskPriority.toUpperCase(), status: taskStatus.toUpperCase().replaceAll(' ', '_'), dueDate: taskDueDate || null }) }); setEditingTask(null); await loadDashboard(); notify('Task updated successfully') } catch (error) { notify(error instanceof Error ? error.message : 'Unable to update task') } }

  const setFilter = (key: string, value: string) => { const params = new URLSearchParams(window.location.search); value ? params.set(key, value) : params.delete(key); window.history.replaceState({}, '', `${window.location.pathname}?${params}`); if (key === 'status') setStatusFilter(value); if (key === 'priority') setPriorityFilter(value); if (key === 'from') setDueFrom(value); if (key === 'to') setDueTo(value) }
  const completeTask = async (task: Task) => { const nextStatus = task.status === 'Done' ? 'TODO' : 'DONE'; try { await api(`/api/tasks/${task.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: nextStatus }) }); await loadDashboard(); notify(nextStatus === 'DONE' ? `Task #${task.id} marked complete` : `Task #${task.id} marked undone`) } catch (error) { notify(error instanceof Error ? error.message : 'Unable to update task') } }

  const notify = (message: string) => {
    setNotice(message)
    window.setTimeout(() => setNotice(''), 2600)
  }

  const logout = async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' })
    } finally {
      setAccessToken('')
      setCurrentUser(null)
      setShowProfileMenu(false)
    }
  }

  if (!accessToken) return <div className="login-screen"><div className="login-card"><div className="brand login-brand"><span className="brand-mark"><Zap size={17} fill="currentColor" /></span><span>orbit<span className="brand-dot">.</span></span></div><div className="auth-tabs"><button className={authMode === 'login' ? 'auth-tab active' : 'auth-tab'} onClick={() => setAuthMode('login')}>Sign in</button><button className={authMode === 'register' ? 'auth-tab active' : 'auth-tab'} onClick={() => setAuthMode('register')}>Create account</button></div><p className="eyebrow">VELOZITY GLOBAL SOLUTIONS</p><h1>{authMode === 'login' ? 'Sign in to your workspace' : 'Create your workspace account'}</h1><p className="login-copy">{authMode === 'login' ? "Manage projects, tasks, and your team's live activity." : 'Choose an account type. Privileged roles require Admin provisioning.'}</p>{authMode === 'login' && <div className="login-as"><span>Login as</span>{(['Admin', 'Project Manager', 'Developer'] as Role[]).map((item) => <button type="button" key={item} className={loginAsRole === item ? 'role-chip selected' : 'role-chip'} onClick={() => chooseRole(item)}>{item}</button>)}</div>}<form onSubmit={authMode === 'login' ? login : register}>{authMode === 'register' && <label>Name<input type="text" value={registerName} onChange={(event) => setRegisterName(event.target.value)} required /></label>}{authMode === 'register' && <label>Account type<select className="account-role-select" value={registerRole} onChange={(event) => setRegisterRole(event.target.value as Role)}><option value="Developer">Developer</option><option value="Project Manager">Project Manager (Admin only)</option><option value="Admin">Admin (Admin only)</option></select></label>}<label>Email<input type="email" value={loginEmail} onChange={(event) => setLoginEmail(event.target.value)} required /></label><label>Password<input type="password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} required minLength={8} /></label>{loginError && <p className="login-error">{loginError}</p>}<button className="primary-button login-button" type="submit">{authMode === 'login' ? 'Sign in' : 'Create account'} <Zap size={15} /></button></form>{authMode === 'login' && <small>Enter the password configured for the selected seeded account.</small>}</div></div>

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><Zap size={17} fill="currentColor" /></span><span>orbit<span className="brand-dot">.</span></span></div>
        <div className="workspace-switcher"><div className="workspace-icon">VG</div><div><strong>Velozity Global</strong><small>Agency workspace</small></div><ChevronDown size={15} /></div>
        <nav className="nav-list" aria-label="Main navigation">
          <span className="nav-label">Workspace</span>
          {['Overview', 'Projects', 'My tasks', 'Team'].map((item) => <button className={activeNav === item ? 'nav-item active' : 'nav-item'} key={item} onClick={() => setActiveNav(item)}><LayoutDashboard size={17} />{item}{item === 'My tasks' && <span className="nav-count">8</span>}</button>)}
          <span className="nav-label nav-label-gap">Manage</span>
          <button className="nav-item" onClick={() => notify('Team management is available to admins')}><Users size={17} />People</button>
          <button className="nav-item" onClick={() => notify('Settings opened')}><Settings size={17} />Settings</button>
        </nav>
        <div className="sidebar-bottom"><div className="help-row"><CircleHelp size={17} /> Help center</div><div className="profile"><div className="avatar avatar-coral">{userInitials(currentUser?.name ?? 'User')}</div><div><strong>{currentUser?.name ?? 'User'}</strong><small>{role}</small></div></div><button className="sidebar-logout" onClick={() => void logout()}><LogOut size={15} /> Log out</button></div>
      </aside>

      <main className="main-content">
        <header className="topbar"><button className="mobile-menu" aria-label="Open menu"><Menu size={20} /></button><div className="breadcrumbs"><span>Workspace</span><b>/</b><strong>{activeNav}</strong></div><div className="top-actions"><span className="live-presence"><span className="presence-dot"></span> {onlineUsers} online</span><div className="notification-wrap"><button className="icon-button notification-button" onClick={() => setShowNotifications(!showNotifications)} aria-label="Notifications"><Bell size={19} /><span className="notification-dot">{notificationCount}</span></button>{showNotifications && <div className="notification-popover"><div className="popover-header"><strong>Notifications</strong><button onClick={() => setShowNotifications(false)}><X size={15} /></button></div>{notifications.length ? notifications.map((item) => <button className={item.readAt ? 'notification-item read' : 'notification-item'} key={item.id} onClick={async () => { if (!item.readAt) { await api(`/api/notifications/${item.id}/read`, { method: 'PATCH' }); setNotifications((current) => current.map((entry) => entry.id === item.id ? { ...entry, readAt: new Date().toISOString() } : entry)); setNotificationCount((count) => Math.max(0, count - 1)) } }}>{item.message}<small>{relativeTime(item.createdAt)}</small></button>) : <p>You are all caught up.</p>}<button className="mark-read" onClick={async () => { await api('/api/notifications/read-all', { method: 'POST' }); setNotifications((current) => current.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() }))); setNotificationCount(0); notify('All notifications marked as read') }}>Mark all as read</button></div>}</div><div className="profile-menu-wrap"><button className="top-avatar" onClick={() => setShowProfileMenu(!showProfileMenu)} aria-label="Open profile menu" aria-expanded={showProfileMenu}>{userInitials(currentUser?.name ?? 'User')}</button>{showProfileMenu && <div className="profile-menu"><strong>{currentUser?.name}</strong><small>{role}</small><button onClick={() => void logout()}>Log out</button></div>}</div></div></header>

        <div className="content-wrap">
          <div className="page-heading"><div><p className="eyebrow">MONDAY, SEPTEMBER 11, 2026</p><h1>{activeNav === 'Overview' ? `Good morning, ${currentUser?.name ?? 'there'}` : activeNav}</h1><p className="subtitle">{activeNav === 'Overview' ? 'Here is what is happening across your workspace today.' : `Manage your ${activeNav.toLowerCase()} in this workspace.`}</p></div><div className="heading-actions">{activeNav !== 'Team' && <button className="secondary-button" onClick={() => notify('Invite link copied to clipboard')}><Users size={16} /> Invite teammate</button>}{(activeNav === 'Overview' || activeNav === 'Projects') && <button className="primary-button" onClick={() => role === 'Developer' ? notify('Developers cannot create projects') : openNewProject()}><Plus size={17} /> New project</button>}</div></div>

          {activeNav === 'Overview' && <>
          <section className="metric-grid"><Metric icon="projects" label="Total projects" value={String(summary.projects)} trend="" detail="from workspace" /><Metric icon="tasks" label="Total tasks" value={String(summary.totalTasks)} trend="" detail={`${summary.inProgress} in progress`} /><Metric icon="overdue" label="Overdue tasks" value={String(summary.overdue).padStart(2, '0')} trend="" detail="needs attention" warning /><Metric icon="online" label="Team online" value={String(onlineUsers)} trend="" detail="live presence" live /></section>

          <section className="insight-grid"><div className="panel insight-panel"><div className="panel-header"><div><h2>Tasks by status</h2><p>Current workspace breakdown</p></div></div><div className="insight-values">{summary.statuses.map((item) => <div key={item.status}><strong>{item._count}</strong><span>{item.status.replaceAll('_', ' ')}</span></div>)}</div></div><div className="panel insight-panel"><div className="panel-header"><div><h2>Tasks by priority</h2><p>Role-scoped workload</p></div></div><div className="insight-values">{summary.priorities.map((item) => <div key={item.priority}><strong>{item._count}</strong><span>{item.priority}</span></div>)}</div></div><div className="panel insight-panel"><div className="panel-header"><div><h2>Due this week</h2><p>Upcoming delivery dates</p></div></div><div className="due-list">{summary.upcomingDue.length ? summary.upcomingDue.slice(0, 3).map((item) => <div key={item.id}><strong>{item.title}</strong><span>{new Date(item.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span></div>) : <span className="empty-inline">No upcoming tasks</span>}</div></div></section>

          <section className="dashboard-grid"><div className="panel tasks-panel"><div className="panel-header"><div><h2>Active tasks</h2><p>Across all projects</p></div><button className="text-button" onClick={() => setActiveNav('My tasks')}>View all <span>→</span></button></div><div className="filter-bar"><div className="search-input"><Search size={16} /><input aria-label="Search tasks" placeholder="Search tasks..." value={search} onChange={(event) => setSearch(event.target.value)} /></div><div className="select-wrap"><Filter size={14} /><select value={statusFilter} onChange={(event) => setFilter('status', event.target.value)}><option value="">All statuses</option><option value="To Do">To Do</option><option value="In Progress">In Progress</option><option value="In Review">In Review</option><option value="Done">Done</option></select></div><div className="select-wrap"><select aria-label="Filter by priority" value={priorityFilter} onChange={(event) => setFilter('priority', event.target.value)}><option value="">All priorities</option><option>Low</option><option>Medium</option><option>High</option><option>Critical</option></select></div><input className="date-filter" aria-label="Due from" type="date" value={dueFrom} onChange={(event) => setFilter('from', event.target.value)} /><input className="date-filter" aria-label="Due to" type="date" value={dueTo} onChange={(event) => setFilter('to', event.target.value)} /><button className="filter-button" onClick={() => { setFilter('status', ''); setFilter('priority', ''); setFilter('from', ''); setFilter('to', '') }}><Filter size={15} /> Clear</button></div><div className="task-list">{filteredTasks.map((task) => <TaskRow key={task.id} task={task} onChange={() => completeTask(task)} onEdit={currentUser?.role !== 'DEVELOPER' ? openTaskEdit : undefined} />)}{filteredTasks.length === 0 && <div className="empty-state">No tasks match those filters.</div>}</div></div>

            <div className="panel activity-panel"><div className="panel-header"><div><h2>Live activity</h2><p><span className="pulse"></span> Updates in real time</p></div><button className="icon-button"><MoreHorizontal size={18} /></button></div><div className="activity-list">{activity.map((item, index) => <div className="activity-item" key={`${item.name}-${item.time}-${index}`}><div className={`activity-avatar ${item.color}`}>{item.name.split(' ').map((part) => part[0]).join('')}</div><div className="activity-copy"><p><strong>{item.name}</strong> {item.action}</p><small>{item.time}</small></div>{index === 0 && <span className="activity-live">LIVE</span>}</div>)}</div><button className="activity-footer" onClick={() => notify('Activity history opened')}>See full activity <span>→</span></button></div></section>

          <section className="bottom-grid"><div className="panel progress-panel"><div className="panel-header"><div><h2>Project health</h2><p>Progress across your active work</p></div><button className="icon-button"><MoreHorizontal size={18} /></button></div><div className="project-health"><HealthRow name="Atlas Mobile App" client="Acme Inc." progress={76} color="coral" due="Sep 18" /><HealthRow name="Northstar Rebrand" client="Northwind Co." progress={52} color="teal" due="Sep 24" /><HealthRow name="Canvas Campaign" client="Canvas Studio" progress={31} color="yellow" due="Oct 02" /></div></div><div className="panel role-panel"><div className="panel-header"><div><h2>View as role</h2><p>Preview permissions by role</p></div><ShieldCheck size={20} className="shield-icon" /></div><div className="role-options">{(['Admin', 'Project Manager', 'Developer'] as Role[]).map((item) => <button key={item} className={role === item ? 'role-option selected' : 'role-option'} onClick={() => { setRole(item); notify(`Viewing dashboard as ${item}`) }}><span className="role-radio">{role === item && <Check size={12} />}</span><span>{item}</span><ChevronDown size={14} /></button>)}</div><div className="role-note"><ShieldCheck size={15} /> API-enforced access control enabled</div></div></section>
          </>}
          {activeNav === 'Projects' && <ProjectsView projects={projects} onEdit={currentUser?.role !== 'DEVELOPER' ? openProjectEdit : undefined} />}
          {activeNav === 'My tasks' && <TaskView tasks={filteredTasks} onComplete={completeTask} onEdit={currentUser?.role !== 'DEVELOPER' ? openTaskEdit : undefined} />}
          {activeNav === 'Team' && <TeamView team={team} />}
        </div>
      </main>
      {showProjectForm && <div className="modal-backdrop" onClick={() => setShowProjectForm(false)}><form className="project-modal" onSubmit={createProject} onClick={(event) => event.stopPropagation()}><div className="modal-header"><div><p className="eyebrow">PROJECT SETUP</p><h2>{editingProject ? 'Edit project' : 'Create a project'}</h2></div><button type="button" className="icon-button" onClick={() => setShowProjectForm(false)}><X size={18} /></button></div><label>Project name<input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="e.g. Website redesign" required /></label><label>Client<select value={projectClientId} onChange={(event) => setProjectClientId(event.target.value)} required><option value="">Choose a client</option>{clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label><TeamMemberPicker team={team} draftIds={draftProjectTeamMemberIds} confirmedIds={projectTeamMemberIds} onDraftChange={setDraftProjectTeamMemberIds} onConfirm={() => { setProjectTeamMemberIds(draftProjectTeamMemberIds); if (!draftProjectTeamMemberIds.includes(projectTeamLeaderId)) setProjectTeamLeaderId('') }} /><label>Team leader<select value={projectTeamLeaderId} onChange={(event) => setProjectTeamLeaderId(event.target.value)} required><option value="">Choose a team leader</option>{team.filter((member) => projectTeamMemberIds.includes(member.id)).map((member) => <option key={member.id} value={member.id}>{member.name} ({member.email})</option>)}</select></label><label>Project requirements<textarea value={projectRequirements} onChange={(event) => setProjectRequirements(event.target.value)} placeholder="Describe the project scope and requirements" rows={4} /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setShowProjectForm(false)}>Cancel</button><button type="submit" className="primary-button">{editingProject ? 'Save project' : 'Create project'}</button></div></form></div>}
      {editingTask && <div className="modal-backdrop" onClick={() => setEditingTask(null)}><form className="project-modal" onSubmit={updateTask} onClick={(event) => event.stopPropagation()}><div className="modal-header"><div><p className="eyebrow">TASK EDIT</p><h2>Edit task</h2></div><button type="button" className="icon-button" onClick={() => setEditingTask(null)}><X size={18} /></button></div><label>Task title<input value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} required /></label><label>Description<textarea value={taskDescription} onChange={(event) => setTaskDescription(event.target.value)} rows={3} /></label><div className="modal-form-grid"><label>Priority<select value={taskPriority} onChange={(event) => setTaskPriority(event.target.value as Priority)}>{(['Low', 'Medium', 'High', 'Critical'] as Priority[]).map((item) => <option key={item}>{item}</option>)}</select></label><label>Status<select value={taskStatus} onChange={(event) => setTaskStatus(event.target.value as Status)}>{(['To Do', 'In Progress', 'In Review', 'Done'] as Status[]).map((item) => <option key={item}>{item}</option>)}</select></label></div><label>Due date<input type="date" value={taskDueDate} onChange={(event) => setTaskDueDate(event.target.value)} /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setEditingTask(null)}>Cancel</button><button type="submit" className="primary-button">Save task</button></div></form></div>}
      {notice && <div className="toast"><Check size={16} /> {notice}</div>}
    </div>
  )
}

function TeamMemberPicker({ team, draftIds, confirmedIds, onDraftChange, onConfirm }: { team: TeamMember[]; draftIds: string[]; confirmedIds: string[]; onDraftChange: (ids: string[]) => void; onConfirm: () => void }) {
  const developers = team.filter((member) => member.role === 'DEVELOPER')
  const initialRows = ((confirmedIds.length ? confirmedIds : draftIds).map((id) => developers.find((member) => member.id === id)).filter((member): member is TeamMember => Boolean(member)).map((member) => ({ name: member.name, email: member.email }))).concat(confirmedIds.length || draftIds.length ? [] : [{ name: '', email: '' }])
  const [rows, setRows] = useState(initialRows)
  const [error, setError] = useState('')
  const updateRow = (index: number, key: 'name' | 'email', value: string) => setRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, [key]: value } : row))
  const confirmRows = () => { const matches = rows.map((row) => developers.find((member) => member.email.toLowerCase() === row.email.trim().toLowerCase() && member.name.toLowerCase() === row.name.trim().toLowerCase())); if (matches.some((member) => !member) || !rows.some((row) => row.name.trim() && row.email.trim())) return setError('Enter the exact name and email of each Developer account.') ; const ids = matches.filter((member): member is TeamMember => Boolean(member)).map((member) => member.id); onDraftChange(ids); onConfirm(); setError('') }
  return <div className="team-picker"><div className="team-picker-heading"><span>Team members</span><button type="button" className="confirm-team-button" onClick={confirmRows}>Confirm members</button></div><div className="team-picker-header"><span>Name</span><span>Email-ID</span></div><div className="team-picker-list">{rows.map((row, index) => <div className="team-picker-row" key={index}><input value={row.name} onChange={(event) => updateRow(index, 'name', event.target.value)} placeholder="Member name" /><input value={row.email} onChange={(event) => updateRow(index, 'email', event.target.value)} placeholder="member@email.com" /></div>)}</div><button type="button" className="add-team-button" onClick={() => setRows((current) => [...current, { name: '', email: '' }])}>+ Add team member</button>{error && <small className="team-picker-error">{error}</small>}<small>Enter existing Developer account details, then confirm them before choosing a team leader.</small></div>
}

function ProjectsView({ projects, onEdit }: { projects: ProjectItem[]; onEdit?: (project: ProjectItem) => void }) {
  return <section className="page-grid">{projects.map((project) => <article className="panel project-card" key={project.id}><div className="project-card-top"><div className="project-badge">{project.name.slice(0, 2).toUpperCase()}</div>{onEdit && <button className="icon-button" aria-label={`Edit ${project.name}`} onClick={() => onEdit(project)}><MoreHorizontal size={18} /></button>}</div><h2>{project.name}</h2><p>{project.client.name}</p><div className="project-meta"><span>Owner: {project.owner.name}</span><strong>{project._count.tasks} tasks</strong></div><div className="progress-track"><div className="progress-fill coral" style={{ width: `${Math.min(100, project._count.tasks * 12)}%` }} /></div></article>)}{projects.length === 0 && <div className="panel empty-page"><h2>No projects yet</h2><p>Create your first client project to get started.</p></div>}</section>
}

function TaskView({ tasks, onComplete, onEdit }: { tasks: Task[]; onComplete: (task: Task) => void; onEdit?: (task: Task) => void }) {
  return <section className="panel standalone-list"><div className="panel-header"><div><h2>My tasks</h2><p>Sorted by priority and due date</p></div></div><div className="task-list">{tasks.map((task) => <TaskRow key={task.id} task={task} onChange={() => onComplete(task)} onEdit={onEdit} />)}{tasks.length === 0 && <div className="empty-page"><h2>No assigned tasks</h2><p>Your assigned work will appear here.</p></div>}</div></section>
}

function TeamView({ team }: { team: TeamMember[] }) {
  return <section className="panel standalone-list"><div className="panel-header"><div><h2>Team</h2><p>Workspace members and roles</p></div></div><div className="team-list">{team.map((member) => <div className="team-row" key={member.id}><div className="avatar avatar-teal">{userInitials(member.name)}</div><div><strong>{member.name}</strong><small>{member.email}</small></div><span>{member.role.replace('_', ' ')}</span></div>)}{team.length === 0 && <div className="empty-page"><h2>No team members available</h2></div>}</div></section>
}

function Metric({ icon, label, value, trend, detail, warning, live }: { icon: string; label: string; value: string; trend: string; detail: string; warning?: boolean; live?: boolean }) {
  return <div className="metric-card"><div className={`metric-icon ${icon}`}>{icon === 'projects' ? <LayoutDashboard size={18} /> : icon === 'tasks' ? <Check size={19} /> : icon === 'overdue' ? <span>!</span> : <span className="metric-live-dot"></span>}</div><div className="metric-copy"><p>{label}</p><strong>{value}</strong><small className={warning ? 'trend warning' : 'trend'}>{live ? <span className="small-live"><span className="presence-dot"></span> Live now</span> : trend} <em>{detail}</em></small></div></div>
}

function TaskRow({ task, onChange, onEdit }: { task: Task; onChange: () => void; onEdit?: (task: Task) => void }) {
  const isDone = task.status === 'Done'
  return <div className="task-row"><div className="task-check"><button className={isDone ? 'done' : ''} onClick={onChange} aria-label={isDone ? `Mark ${task.title} undone` : `Mark ${task.title} complete`} aria-pressed={isDone}><Check size={13} /></button></div><div className="task-main"><strong>{task.title}</strong><span>{task.project}</span></div><span className={`priority priority-${task.priority.toLowerCase()}`}>{task.priority}</span><span className={`status status-${task.status.toLowerCase().replace(' ', '-')}`}>{task.status}</span><div className="assignee"><span className="avatar avatar-teal">{task.initials}</span><span>{task.assignee.split(' ')[0]}</span></div><span className={task.status === 'Overdue' ? 'due overdue' : 'due'}>{task.due}</span>{onEdit ? <button className="row-more" aria-label={`Edit ${task.title}`} onClick={() => onEdit(task)}><MoreHorizontal size={17} /></button> : <span />}</div>
}

function HealthRow({ name, client, progress, color, due }: { name: string; client: string; progress: number; color: string; due: string }) {
  return <div className="health-row"><div className="health-label"><div><strong>{name}</strong><small>{client}</small></div><span>{progress}%</span></div><div className="progress-track"><div className={`progress-fill ${color}`} style={{ width: `${progress}%` }} /></div><small className="health-due">Due {due}</small></div>
}

export default App
