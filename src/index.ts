import { routeAgentRequest } from "agents";

export { NewsAgent } from "./agents/news-agent";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Static assets (the globe UI in ./public) are served automatically
    // before this handler runs. This only handles agent routes.
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
