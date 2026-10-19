import { useState, useEffect, useCallback, useMemo } from 'react'
import type { Session, WorkspaceProject } from '../types'
import {
  listSessions,
  createSession,
  deleteSession,
  listSessionDirectories,
} from '../api/sessions'

export interface SessionProject extends WorkspaceProject {
  sessions: Session[]
  loading: boolean
}

const OPEN_PROJECTS_STORAGE_KEY = 'mycode.openProjects.v1'
const ACTIVE_PROJECT_STORAGE_KEY = 'mycode.activeProjectDir.v1'
const ACTIVE_SESSIONS_STORAGE_KEY = 'mycode.activeSessionsByProject.v1'

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : fallback
  } catch {
    return fallback
  }
}

function persistJson(key: string, value: unknown) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(key, JSON.stringify(value))
}

function readStoredProjectDirectories(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(OPEN_PROJECTS_STORAGE_KEY)
    if (raw == null) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function sortSessions(list: Session[]): Session[] {
  return [...list].sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
}

function normalizeDirectory(directory: string): string {
  // Windows paths reach us in both slash styles and with inconsistent
  // drive-letter casing. Compare on a canonical form so a folder stored
  // in localStorage always matches the same folder returned by the API.
  return directory.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function latestSessionTime(project: SessionProject): number {
  return project.sessions.reduce(
    (latest, session) => Math.max(latest, session.time.updated ?? session.time.created),
    0,
  )
}

function basename(directory: string): string {
  const trimmed = normalizeDirectory(directory)
  const parts = trimmed.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] || trimmed || directory
}

function buildWorkspaceProject(directory: string): WorkspaceProject {
  return {
    id: directory,
    directory,
    name: basename(directory),
    worktree: directory,
  }
}

async function loadProjectState(directory: string): Promise<SessionProject | null> {
  try {
    const sessions = await listSessions(directory)
    const normalizedDirectory = normalizeDirectory(directory)
    const scopedSessions = sessions.filter((session) => normalizeDirectory(session.directory) === normalizedDirectory)

    return {
      ...buildWorkspaceProject(directory),
      sessions: sortSessions(scopedSessions),
      loading: false,
    }
  } catch (err) {
    console.error('Failed to load project state', directory, err)
    return null
  }
}

function createPendingProject(directory: string): SessionProject {
  return {
    ...buildWorkspaceProject(directory),
    sessions: [],
    loading: true,
  }
}

export function useSession() {
  const [projects, setProjects] = useState<SessionProject[]>([])
  const [activeProjectDirectory, setActiveProjectDirectoryState] = useState<string | null>(() =>
    readJson<string | null>(ACTIVE_PROJECT_STORAGE_KEY, null),
  )
  const [activeSessionsByProject, setActiveSessionsByProject] = useState<Record<string, string | null>>(() =>
    readJson<Record<string, string | null>>(ACTIVE_SESSIONS_STORAGE_KEY, {}),
  )
  const [lastActive, setLastActive] = useState<{ directory: string; sessionId: string } | null>(null)
  const [loading, setLoading] = useState(true)
  // Guards the persistence effects below: before hydration finishes the
  // in-memory project list is empty, and writing it would erase the very
  // state this effect is about to read on the next refresh.
  const [hydrated, setHydrated] = useState(false)

  const setActiveProjectDirectory = useCallback((directory: string | null) => {
    setActiveProjectDirectoryState(directory)
  }, [])

  useEffect(() => {
    let cancelled = false

    const hydrate = async () => {
      setLoading(true)

      // localStorage remembers what this browser last had open; the backend
      // knows every folder that actually contains sessions. Merge both so a
      // fresh browser (or wiped storage) still restores past conversations.
      const storedDirectories = readStoredProjectDirectories()
      let remoteDirectories: string[] = []
      try {
        remoteDirectories = (await listSessionDirectories()).map((item) => item.directory)
      } catch (err) {
        console.error('Failed to list session directories', err)
      }

      if (cancelled) return

      const seeds: string[] = []
      const seenDirectories = new Set<string>()
      for (const directory of [...storedDirectories, ...remoteDirectories]) {
        const key = normalizeDirectory(directory)
        if (!key || seenDirectories.has(key)) continue
        seenDirectories.add(key)
        seeds.push(directory)
      }

      const loaded = (await Promise.all(seeds.map(loadProjectState))).filter(
        (item): item is SessionProject => !!item,
      )

      if (cancelled) return

      const deduped: SessionProject[] = []
      const seenProjects = new Set<string>()
      for (const project of loaded) {
        const key = normalizeDirectory(project.directory)
        if (seenProjects.has(key)) continue
        seenProjects.add(key)
        deduped.push(project)
      }

      setProjects(deduped)
      setHydrated(true)
      setActiveProjectDirectoryState((prev) => {
        const previous = prev
          ? deduped.find((project) => normalizeDirectory(project.directory) === normalizeDirectory(prev))
          : undefined
        if (previous) return previous.directory

        // No usable stored project: land on the folder with the most
        // recently touched session so the conversation list is never blank
        // when sessions already exist.
        const newest = [...deduped]
          .filter((project) => project.sessions.length > 0)
          .sort((a, b) => latestSessionTime(b) - latestSessionTime(a))[0]
        return newest?.directory ?? deduped[0]?.directory ?? null
      })
      setLoading(false)
    }

    void hydrate()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!hydrated) return
    persistJson(OPEN_PROJECTS_STORAGE_KEY, projects.map((project) => project.directory))
  }, [projects, hydrated])

  useEffect(() => {
    persistJson(ACTIVE_PROJECT_STORAGE_KEY, activeProjectDirectory)
  }, [activeProjectDirectory])

  useEffect(() => {
    persistJson(ACTIVE_SESSIONS_STORAGE_KEY, activeSessionsByProject)
  }, [activeSessionsByProject])

  useEffect(() => {
    if (projects.length === 0) return
    setActiveProjectDirectoryState((prev) => {
      const match = prev
        ? projects.find((project) => normalizeDirectory(project.directory) === normalizeDirectory(prev))
        : undefined
      if (match) return match.directory
      return projects[0].directory
    })
  }, [projects])

  // Pick a session automatically: keep the remembered one when it still
  // exists, otherwise fall back to the most recently updated session in the
  // active folder. This is what makes a refresh land directly in the last
  // conversation instead of an empty chat pane.
  useEffect(() => {
    if (!activeProjectDirectory) return
    const project = projects.find(
      (item) => normalizeDirectory(item.directory) === normalizeDirectory(activeProjectDirectory),
    )
    if (!project) return

    const activeId = activeSessionsByProject[project.directory]
    if (activeId && project.sessions.some((session) => session.id === activeId)) return
    const fallbackId = project.sessions[0]?.id ?? null
    if ((activeId ?? null) === fallbackId) return

    setActiveSessionsByProject((prev) => ({
      ...prev,
      [project.directory]: fallbackId,
    }))
  }, [activeProjectDirectory, activeSessionsByProject, projects])

  const refreshProject = useCallback(async (directory: string) => {
    setProjects((prev) =>
      prev.map((project) => (project.directory === directory ? { ...project, loading: true } : project)),
    )

    const next = await loadProjectState(directory)
    if (!next) {
      setProjects((prev) =>
        prev.map((project) => (project.directory === directory ? { ...project, loading: false } : project)),
      )
      return
    }

    setProjects((prev) => {
      const index = prev.findIndex((project) => project.directory === directory)
      if (index === -1) return [...prev, next]
      const copy = [...prev]
      copy[index] = next
      return copy
    })
  }, [])

  const openProject = useCallback(async (directory: string) => {
    // Reuse the folder already in the list when it differs only by slash
    // style or drive-letter case, instead of adding a duplicate project.
    const existing = projects.find(
      (project) => normalizeDirectory(project.directory) === normalizeDirectory(directory),
    )
    const canonical = existing?.directory ?? directory

    setActiveProjectDirectoryState(canonical)
    setProjects((prev) => {
      const existingIndex = prev.findIndex(
        (project) => normalizeDirectory(project.directory) === normalizeDirectory(canonical),
      )
      if (existingIndex !== -1) {
        const copy = [...prev]
        copy[existingIndex] = { ...copy[existingIndex], loading: true }
        return copy
      }
      return [...prev, createPendingProject(canonical)]
    })

    const next = await loadProjectState(canonical)
    if (!next) return null

    setProjects((prev) => {
      const existingIndex = prev.findIndex(
        (project) => normalizeDirectory(project.directory) === normalizeDirectory(next.directory),
      )
      if (existingIndex === -1) return [...prev, next]
      const copy = [...prev]
      copy[existingIndex] = next
      return copy
    })
    return next
  }, [projects])

  const closeProject = useCallback((directory: string) => {
    const index = projects.findIndex(
      (project) => normalizeDirectory(project.directory) === normalizeDirectory(directory),
    )
    if (index === -1) return
    const removed = projects[index]

    const remaining = projects.filter((project) => project !== removed)
    const fallbackDirectory = remaining[Math.min(index, remaining.length - 1)]?.directory ?? remaining[0]?.directory ?? null

    setProjects(remaining)
    setActiveProjectDirectoryState((prev) =>
      prev && normalizeDirectory(prev) === normalizeDirectory(removed.directory) ? fallbackDirectory : prev,
    )
    setActiveSessionsByProject((prev) => {
      const next = { ...prev }
      delete next[removed.directory]
      return next
    })
    setLastActive((prev) => (prev?.directory === removed.directory ? null : prev))
  }, [projects])

  const setActiveSession = useCallback((directory: string, sessionId: string | null) => {
    const canonical = projects.find(
      (project) => normalizeDirectory(project.directory) === normalizeDirectory(directory),
    )?.directory ?? directory

    setActiveSessionsByProject((prev) => {
      const previous = prev[canonical]
      if (previous && previous !== sessionId) {
        setLastActive({ directory: canonical, sessionId: previous })
      }
      return {
        ...prev,
        [canonical]: sessionId,
      }
    })
    setActiveProjectDirectoryState(canonical)
  }, [projects])

  const create = useCallback(async (directory?: string) => {
    const targetDirectory = directory ?? activeProjectDirectory ?? projects[0]?.directory
    if (!targetDirectory) return null

    const session = await createSession(undefined, targetDirectory)
    setProjects((prev) =>
      prev.map((project) =>
        project.directory === targetDirectory
          ? { ...project, sessions: [session, ...project.sessions] }
          : project,
      ),
    )
    setActiveSession(targetDirectory, session.id)
    return session
  }, [activeProjectDirectory, projects, setActiveSession])

  const remove = useCallback(async (id: string, directory?: string) => {
    const targetDirectory = directory ?? activeProjectDirectory
    if (!targetDirectory) return

    try {
      await deleteSession(id, targetDirectory)
    } catch (err) {
      console.error('Failed to delete session', err)
    }

    setProjects((prev) =>
      prev.map((project) =>
        project.directory === targetDirectory
          ? { ...project, sessions: project.sessions.filter((session) => session.id !== id) }
          : project,
      ),
    )

    if (activeSessionsByProject[targetDirectory] === id) {
      const project = projects.find((item) => item.directory === targetDirectory)
      const fallbackId = project?.sessions.find((session) => session.id !== id)?.id ?? null
      setActiveSession(targetDirectory, fallbackId)
    }
  }, [activeProjectDirectory, activeSessionsByProject, projects, setActiveSession])

  const returnToLastSession = useCallback(() => {
    if (!lastActive) return
    setActiveSession(lastActive.directory, lastActive.sessionId)
  }, [lastActive, setActiveSession])

  const selectSessionById = useCallback((sessionId: string) => {
    for (const project of projects) {
      const match = project.sessions.find((session) => session.id === sessionId)
      if (match) {
        setActiveSession(project.directory, match.id)
        return
      }
    }
  }, [projects, setActiveSession])

  const activeProject = useMemo(
    () =>
      activeProjectDirectory
        ? projects.find(
            (project) => normalizeDirectory(project.directory) === normalizeDirectory(activeProjectDirectory),
          ) ?? null
        : null,
    [activeProjectDirectory, projects],
  )
  const activeId = activeProject ? activeSessionsByProject[activeProject.directory] ?? null : null
  const active = activeProject?.sessions.find((session) => session.id === activeId) ?? null
  const allSessions = useMemo(
    () => sortSessions(projects.flatMap((project) => project.sessions)),
    [projects],
  )
  const canReturnToLastSession = useMemo(
    () =>
      Boolean(
        lastActive &&
        (lastActive.directory !== activeProjectDirectory || lastActive.sessionId !== activeId) &&
        projects.some((project) => project.directory === lastActive.directory) &&
        projects.some((project) => project.sessions.some((session) => session.id === lastActive.sessionId)),
      ),
    [activeId, activeProjectDirectory, lastActive, projects],
  )

  return {
    projects,
    activeProject,
    activeProjectDirectory,
    active,
    activeId,
    allSessions,
    loading,
    setActiveProjectDirectory,
    setActiveSession,
    selectSessionById,
    openProject,
    closeProject,
    refreshProject,
    create,
    remove,
    lastActive,
    returnToLastSession,
    canReturnToLastSession,
  }
}
