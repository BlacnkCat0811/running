import type { FastifyInstance } from "fastify";
import type { CommandResponse } from "@rai/api-contracts";
import type { CommandQueue, CommandRequest, DurableCommand } from "../command-queue.js";
import { commandBodySchema, identifierParamsSchema } from "../schemas.js";

const publicCommand = ({ id, kind, status, createdAt, completedAt, result, error }: DurableCommand): CommandResponse => ({
  id, kind, status, createdAt, completedAt, ...(result === undefined ? {} : { result }),
  ...(error === undefined ? {} : { error })
});

export function registerCommandRoutes(app: FastifyInstance, commands: CommandQueue): void {
  app.post<{ Body: CommandRequest }>("/v1/commands", { schema: { body: commandBodySchema } }, async (request, reply) => {
    const command = commands.enqueue(request.body);
    return reply.code(command.status === "queued" ? 202 : 200).send(publicCommand(command));
  });
  app.get<{ Params: { id: string } }>("/v1/commands/:id", { schema: { params: identifierParamsSchema } }, async (request, reply) => {
    const command = commands.get(request.params.id);
    if (!command) return reply.code(404).send({ message: "未找到写操作" });
    return publicCommand(command);
  });
  app.post<{ Params: { id: string } }>("/v1/commands/:id/cancel", { schema: { params: identifierParamsSchema } }, async (request, reply) => {
    const outcome = commands.cancel(request.params.id);
    if (outcome === "not_found") return reply.code(404).send({ message: "未找到写操作" });
    if (outcome === "busy") return reply.code(409).send({ message: "操作已经执行或完成，不能取消" });
    return { status: "cancelled" };
  });
}
