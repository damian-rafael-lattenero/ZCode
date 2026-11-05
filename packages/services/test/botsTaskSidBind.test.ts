/* [fork] U2 — la ley del owner (5/11): elegir una conversación en el bot
 * (/task <sid> o el bindTaskId del canal daemon) y hablar aterriza en ESA
 * conversación, aunque viva en otro workspace — especialmente los drafts
 * (~/.zcode/workspace/draft-*, projectId null) que el catálogo del bot jamás
 * lista. El sid es globalmente único: se resuelve del árbol de proyectos por
 * taskId exacto, y el bind re-apunta el contexto COMPLETO al mundo de la task.
 * Queda intacto el veredicto taskRunning y el taskMissing de un sid falso.
 */
import { describe, expect, it, vi } from "vitest";
import type { BotInboundMessage } from "@zcode/shared";
import type { VirtualProject } from "../src/project/contract.js";
import * as f from "./botsService.fixtures.js";

const ALPHA_WORKSPACE = "/owner/workspace/alpha";
const BETA_WORKSPACE = "/owner/workspace/beta";
const DRAFT_WORKSPACE = "/owner/workspace/draft-d1d1d1d1-2222-4333-8444-555555555555";

function treeTask(overrides: { taskId: string } & Record<string, unknown>) {
  return {
    traceId: `trace-${overrides.taskId}`,
    title: overrides.taskId,
    workspacePath: ALPHA_WORKSPACE,
    createdAt: 1,
    updatedAt: 1,
    mode: "build" as const,
    pinned: false,
    archived: false,
    hostId: "local",
    projectId: null,
    ...overrides,
  };
}

const projects: VirtualProject[] = [
  {
    id: "proj-alpha",
    hostId: "local",
    name: "alpha",
    roots: [{ rootPath: ALPHA_WORKSPACE, position: 0, isPrimary: true }],
    nameOverridden: false,
    position: 0,
    pinned: false,
    deleted: false,
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: "proj-beta",
    hostId: "local",
    name: "beta",
    roots: [{ rootPath: BETA_WORKSPACE, position: 0, isPrimary: true }],
    nameOverridden: false,
    position: 1,
    pinned: false,
    deleted: false,
    createdAt: 1,
    updatedAt: 1,
  },
];

const treeTasks = [
  treeTask({ taskId: "sess_draft_1", title: "Draft chat", workspacePath: DRAFT_WORKSPACE }),
  treeTask({
    taskId: "sess_alpha_1",
    title: "Alpha chat",
    workspacePath: ALPHA_WORKSPACE,
    projectId: "proj-alpha",
  }),
  treeTask({
    taskId: "sess_beta_1",
    title: "Beta chat",
    workspacePath: BETA_WORKSPACE,
    projectId: "proj-beta",
  }),
];

/** El draft (projectId null) NO es proyecto del catálogo: solo vive en tree.tasks. */
function createStubServices() {
  return {
    projectService: {
      readTree: vi.fn(async () => ({ projects, tasks: treeTasks })),
      readProjects: vi.fn(async () => projects),
      prepareSession: vi.fn(async (input?: { projectId?: string }) => {
        const project = projects.find((item) => item.id === input?.projectId);
        if (!project) throw new Error("project missing");
        return {
          workspacePath: project.roots[0]!.rootPath,
          additionalDirectories: [],
          projectId: project.id,
        };
      }),
    },
    remoteProjectService: { readDirectory: vi.fn(async () => ({ hosts: [], entries: [] })) },
  };
}

function createBoundTaskService() {
  const taskService = f.createLegacyTaskService();
  (taskService.listTasks as ReturnType<typeof vi.fn>).mockImplementation(
    async (input?: { workspacePath?: string }) =>
      treeTasks.filter((task) => task.workspacePath === input?.workspacePath),
  );
  return taskService;
}

function inbound(text: string): BotInboundMessage {
  return {
    botId: "telegram-1",
    actor: {
      provider: "telegram",
      botId: "telegram-1",
      providerUserId: "user-1",
      chatType: "private",
    },
    text,
    receivedAt: 1,
  } as BotInboundMessage;
}

async function startService() {
  const repo = f.createMemoryRepo(f.telegramConfig);
  const taskService = createBoundTaskService();
  const services = createStubServices();
  const botsService = f.createBotsService({
    repo: repo as never,
    legacyTaskService: taskService as never,
    projectService: services.projectService as never,
    remoteProjectService: services.remoteProjectService as never,
  });
  return { repo, taskService, botsService };
}

async function contextOf(repo: ReturnType<typeof f.createMemoryRepo>) {
  const context = (await repo.readState()).bots["telegram-1"];
  if (!context) throw new Error("context missing");
  return context;
}

describe("bot /task <sid> bind (the owner's 5/11 law)", () => {
  it("(a) binds a draft-workspace task by full sid and the whole context re-points to the draft", async () => {
    const { repo, taskService, botsService } = await startService();
    try {
      const replies = await botsService.handleInboundMessage(inbound("/task sess_draft_1"));
      expect(JSON.stringify(replies)).not.toMatch(/未找到任务|Task not found/);
      const context = await contextOf(repo);
      expect(context).toMatchObject({
        mode: "task",
        activeTaskId: "sess_draft_1",
        workspacePath: DRAFT_WORKSPACE,
        projectId: null,
      });
      // el draft no es workspace de catálogo: identidad por clave, sin id ni directorios heredados
      expect(context.workspaceId).toBeUndefined();
      expect(context.workspaceIdentity).toBeUndefined();
      expect(context.additionalDirectories).toEqual([]);
      // y HABLAR aterriza en ESA conversación (el núcleo de la ley)
      await botsService.handleInboundMessage(inbound("hola draft"));
      await vi.waitFor(() =>
        expect(taskService.sendPrompt).toHaveBeenCalledWith(
          expect.objectContaining({ taskId: "sess_draft_1", content: "hola draft" }),
        ),
      );
    } finally {
      botsService.disposeAll();
    }
  });

  it("(b) binds a task from another project and the context crosses to that workspace", async () => {
    const { repo, taskService, botsService } = await startService();
    try {
      const replies = await botsService.handleInboundMessage(inbound("/task sess_beta_1"));
      expect(JSON.stringify(replies)).not.toMatch(/未找到任务|Task not found/);
      const context = await contextOf(repo);
      expect(context).toMatchObject({
        mode: "task",
        activeTaskId: "sess_beta_1",
        workspacePath: BETA_WORKSPACE,
        projectId: "proj-beta",
      });
      expect(context.workspaceId).toBeUndefined();
      // y hablar sigue entrando a la task del otro proyecto
      await botsService.handleInboundMessage(inbound("hola beta"));
      await vi.waitFor(() =>
        expect(taskService.sendPrompt).toHaveBeenCalledWith(
          expect.objectContaining({ taskId: "sess_beta_1", content: "hola beta" }),
        ),
      );
    } finally {
      botsService.disposeAll();
    }
  });

  it("(c) a running task still refuses the switch with taskRunning and the context stays put", async () => {
    const { repo, taskService, botsService } = await startService();
    try {
      // bind a task del PROPIO workspace y enviar un turno → runningTasks la marca viva
      await botsService.handleInboundMessage(inbound("/task sess_alpha_1"));
      expect(await contextOf(repo)).toMatchObject({
        activeTaskId: "sess_alpha_1",
        workspacePath: ALPHA_WORKSPACE,
      });
      await botsService.handleInboundMessage(inbound("run"));
      await vi.waitFor(() =>
        expect(taskService.sendPrompt).toHaveBeenCalledWith(
          expect.objectContaining({ taskId: "sess_alpha_1" }),
        ),
      );
      // el /task hacia OTRO sid se niega con el veredicto de siempre, sin re-apuntar nada
      const replies = await botsService.handleInboundMessage(inbound("/task sess_draft_1"));
      expect(JSON.stringify(replies)).toMatch(
        /当前任务正在运行|task is still running|still running/iu,
      );
      const context = await contextOf(repo);
      expect(context).toMatchObject({
        activeTaskId: "sess_alpha_1",
        workspacePath: ALPHA_WORKSPACE,
        projectId: "proj-alpha",
      });
      expect(taskService.sendPrompt).not.toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "sess_draft_1" }),
      );
    } finally {
      botsService.disposeAll();
    }
  });

  it("(d) a bogus sid still answers taskMissing and never re-points the context", async () => {
    const { repo, botsService } = await startService();
    try {
      const replies = await botsService.handleInboundMessage(inbound("/task sess_inexistente"));
      expect(JSON.stringify(replies)).toMatch(/未找到任务|Task not found/);
      const context = await contextOf(repo);
      expect(context.activeTaskId).toBeNull();
      expect(context.workspacePath).toBe(ALPHA_WORKSPACE);
    } finally {
      botsService.disposeAll();
    }
  });
});
