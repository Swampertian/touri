import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { useWorkspace } from "../src/useWorkspace"

type ThreadRequest = { botId: string; resolve: () => void }

const getApiWithEmptyBots = ({ failCreate = false, holdCreate = false } = {}) => {
  const api = createMockApi()
  const request = api.request
  const emptyBotIds = new Set<string>()
  const held: Array<ThreadRequest> = []
  const wrapped: ApiRequest = async (route, input, pathValues) => {
    if (route === "GET /bots/:id/threads" && emptyBotIds.has(pathValues?.id ?? "")) return { threads: [] } as never
    if (route === "POST /threads" && failCreate) throw new Error("offline")
    if (route === "POST /threads" && holdCreate) {
      const botId = (input as { botId: string }).botId
      await new Promise<void>((resolve) => held.push({ botId, resolve }))
    }
    return request(route, input, pathValues)
  }
  return { api: { ...api, request: wrapped }, emptyBotIds, held }
}

const renderWorkspace = async (options: { failCreate?: boolean; holdCreate?: boolean } = {}) => {
  const { api, emptyBotIds, held } = getApiWithEmptyBots(options)
  await api.request("PATCH /bots/:id", { paused: false }, { id: "bot-panko" })
  emptyBotIds.add("bot-onb")
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))
  return { api, hook, held }
}

const getThreadPosts = (api: ReturnType<typeof createMockApi>) =>
  api.calls.filter((call) => call.route === "POST /threads")

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it("creates a real thread when a bot without threads is selected", async () => {
  const { hook } = await renderWorkspace()

  act(() => hook.result.current.actions.selectBot("bot-onb"))

  await waitFor(() => expect(hook.result.current.data.threadCreation).toBeNull())
  const { data } = hook.result.current
  expect(data.selectedBotId).toBe("bot-onb")
  expect(data.selectedThreadId).not.toMatch(/^draft:/)
  expect(data.threads.some((thread) => thread.id === data.selectedThreadId && thread.botId === "bot-onb")).toBe(true)
})

it("marks the draft failed instead of pending forever when creation fails", async () => {
  const { hook } = await renderWorkspace({ failCreate: true })

  act(() => hook.result.current.actions.selectBot("bot-onb"))

  await waitFor(() => expect(hook.result.current.data.threadCreation?.status).toBe("failed"))
  expect(hook.result.current.data.selectedThreadId).toBe("draft:bot:bot-onb")
})

it("creates the second draft after a creation that was in flight settles", async () => {
  const { hook, held } = await renderWorkspace({ holdCreate: true })

  act(() => hook.result.current.actions.selectBot("bot-onb"))
  await waitFor(() => expect(held).toHaveLength(1))
  act(() => hook.result.current.actions.selectBot("bot-panko"))
  await act(async () => held[0]?.resolve())
  await waitFor(() => expect(held).toHaveLength(2))
  await act(async () => held[1]?.resolve())

  await waitFor(() => expect(hook.result.current.data.threadCreation).toBeNull())
  const { data } = hook.result.current
  expect(held.map((entry) => entry.botId)).toEqual(["bot-onb", "bot-panko"])
  expect(data.selectedBotId).toBe("bot-panko")
  expect(data.threads.find((thread) => thread.id === data.selectedThreadId)?.botId).toBe("bot-panko")
})

it("keeps a paused bot on a draft without creating a thread until it resumes", async () => {
  const api = createMockApi()
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))

  act(() => hook.result.current.actions.selectBot("bot-panko"))

  expect(hook.result.current.data.threadCreation?.status).toBe("draft")
  expect(getThreadPosts(api)).toHaveLength(0)
  await act(async () => hook.result.current.actions.updateBot("bot-panko", { paused: false }))
  await waitFor(() => expect(hook.result.current.data.threadCreation).toBeNull())
  expect(getThreadPosts(api)).toHaveLength(1)
})

it("opens a focused composer for a paused bot and creates one thread after resuming", async () => {
  const api = createMockApi()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  fireEvent.click(screen.getByRole("button", { name: /^Panko / }))

  const composer = await screen.findByRole("textbox", { name: "Mensagem para Panko" })
  expect(screen.queryByText("Escolha uma conversa")).toBeNull()
  await waitFor(() => expect(composer).toHaveFocus())
  expect(screen.getByText("Panko está pausado")).toBeVisible()
  expect(getThreadPosts(api)).toHaveLength(0)

  fireEvent.click(screen.getByRole("button", { name: "Retomar bot" }))

  await waitFor(() => expect(getThreadPosts(api)).toHaveLength(1))
  await waitFor(() => expect(screen.queryByText("Panko está pausado")).toBeNull())
  expect(screen.getByRole("textbox", { name: "Mensagem para Panko" })).toHaveFocus()

  fireEvent.click(screen.getByRole("button", { name: /^mark / }))
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  fireEvent.click(screen.getByRole("button", { name: /^Panko / }))
  await screen.findByRole("textbox", { name: "Mensagem para Panko" })

  expect(getThreadPosts(api)).toHaveLength(1)
})
