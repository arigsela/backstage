# ==============================================================================
# Orchestrator — FastAPI Application
# ==============================================================================
#
# Entry point for the orchestrator service. Creates a FastAPI web server with:
# - GET  /health   — Health check (K8s probes)
# - POST /invoke   — Route query to sub-agent
# - GET  /info     — Orchestrator metadata
# - Auth, session, and CopilotKit endpoints (conditional)
# - A2A server for agent-to-agent discovery
#
# RUNNING THIS SERVICE:
#   uvicorn orchestrator.main:app --host 0.0.0.0 --port 8000
# ==============================================================================
{% raw %}
import asyncio
import os
import uuid
from contextlib import asynccontextmanager

from a2a.server.agent_execution import AgentExecutor
from a2a.server.agent_execution.context import RequestContext
from a2a.server.apps import A2AStarletteApplication
from a2a.server.events.event_queue import EventQueue
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.tasks import InMemoryTaskStore
from a2a.types import (
    AgentCapabilities,
    AgentCard,
    AgentSkill,
    Message,
    Role,
    TaskState,
    TaskStatus,
    TaskStatusUpdateEvent,
    TextPart,
)
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from shared.a2a_utils import extract_user_input
from shared.config import PROJECT_NAME, ORCHESTRATOR_PORT, API_KEYS
from shared.logging_config import setup_logging
{% endraw %}
{%- if values.enableAuth %}
{% raw %}
from orchestrator.auth import AuthInfo, create_jwt, verify_auth
{% endraw %}
{%- endif %}
{%- if values.enableCopilotKit %}
{% raw %}
try:
    from orchestrator.copilotkit_endpoint import copilotkit_handler
    _HAS_AG_UI = True
except ImportError:
    _HAS_AG_UI = False
{% endraw %}
{%- endif %}
{%- if values.enableSessions %}
{% raw %}
from orchestrator.session_manager import SessionManager
{% endraw %}
{%- endif %}
{%- if values.enableAuth %}
{% raw %}
from orchestrator.user_manager import UserManager
{% endraw %}
{%- endif %}
{% raw %}

logger = setup_logging("orchestrator")


# --- REQUEST/RESPONSE MODELS ---

class InvokeRequest(BaseModel):
    """Request body for the /invoke endpoint."""
    query: str
{% endraw %}
{%- if values.enableSessions %}
{% raw %}
    context_id: str = ""
{% endraw %}
{%- endif %}
{% raw %}


class InvokeResponse(BaseModel):
    """Response body from the /invoke endpoint."""
    result: str
    route: str
{% endraw %}
{%- if values.enableSessions %}
{% raw %}
    context_id: str = ""
{% endraw %}
{%- endif %}
{%- if values.enableAuth %}
{% raw %}


class AuthRequest(BaseModel):
    username: str
    password: str


class AuthResponse(BaseModel):
    token: str
    user_id: str
    username: str
{% endraw %}
{%- endif %}
{% raw %}


# --- A2A Executor ---

class OrchestratorExecutor(AgentExecutor):
    """A2A executor that runs the OrchestratorFlow."""

    async def execute(
        self,
        context: RequestContext,
        event_queue: EventQueue,
    ) -> None:
        task_id = context.task_id
        context_id = context.context_id

        try:
            user_input = extract_user_input(context.message)
            logger.info(f"A2A execute: task_id={task_id}, query={user_input[:80]}...")

            await event_queue.enqueue_event(
                TaskStatusUpdateEvent(
                    task_id=task_id,
                    context_id=context_id,
                    final=False,
                    status=TaskStatus(
                        state=TaskState.working,
                        message=Message(
                            role=Role.agent,
                            message_id=str(uuid.uuid4()),
                            parts=[TextPart(text="Processing query...")],
                        ),
                    ),
                )
            )

            from orchestrator.flow import OrchestratorFlow
            flow = OrchestratorFlow()
            flow.state.query = user_input
            result = await asyncio.to_thread(flow.kickoff)

            await event_queue.enqueue_event(
                TaskStatusUpdateEvent(
                    task_id=task_id,
                    context_id=context_id,
                    final=True,
                    status=TaskStatus(
                        state=TaskState.completed,
                        message=Message(
                            role=Role.agent,
                            message_id=str(uuid.uuid4()),
                            parts=[TextPart(text=str(result))],
                        ),
                    ),
                )
            )

        except Exception as e:
            logger.error(f"Orchestrator executor error: {e}", exc_info=True)
            await event_queue.enqueue_event(
                TaskStatusUpdateEvent(
                    task_id=task_id,
                    context_id=context_id,
                    final=True,
                    status=TaskStatus(
                        state=TaskState.failed,
                        message=Message(
                            role=Role.agent,
                            message_id=str(uuid.uuid4()),
                            parts=[TextPart(text=f"Orchestrator error: {e}")],
                        ),
                    ),
                )
            )

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        raise NotImplementedError("Orchestrator does not support cancellation")


# --- App factory ---

def _build_agent_card() -> AgentCard:
    host = os.getenv("ORCHESTRATOR_HOST", "0.0.0.0")
    port = int(os.getenv("ORCHESTRATOR_PORT", str(ORCHESTRATOR_PORT)))
    url = os.getenv("ORCHESTRATOR_URL", f"http://{host}:{port}")

    return AgentCard(
        name="{% endraw %}${{ values.name }}{% raw %} Orchestrator",
        description="Routes queries to specialized sub-agents via A2A protocol.",
        url=url,
        version="1.0.0",
        default_input_modes=["text"],
        default_output_modes=["text"],
        capabilities=AgentCapabilities(streaming=False),
        skills=[
            AgentSkill(
                id="route-query",
                name="Route Query",
                description="Classify and route a query to the appropriate sub-agent.",
                tags=["routing", "orchestration"],
            ),
        ],
    )


def create_app() -> FastAPI:
    """Create the orchestrator FastAPI application."""

    @asynccontextmanager
    async def lifespan(app: FastAPI):
{% endraw %}
{%- if values.enableAuth %}
{% raw %}
        app.state.user_manager = UserManager()
{% endraw %}
{%- endif %}
{%- if values.enableSessions %}
{% raw %}
        app.state.session_manager = SessionManager()
        app.state.session_manager.start_cleanup_task()
{% endraw %}
{%- endif %}
{% raw %}
        logger.info("Orchestrator started")
        yield
{% endraw %}
{%- if values.enableSessions %}
{% raw %}
        app.state.session_manager.stop_cleanup_task()
{% endraw %}
{%- endif %}
{% raw %}
        logger.info("Orchestrator stopped")

    fastapi_app = FastAPI(
        title="{% endraw %}${{ values.name }}{% raw %} Orchestrator",
        version="1.0.0",
        description="Routes queries to CrewAI sub-agents via A2A protocol.",
        lifespan=lifespan,
    )

    cors_origins = os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",")
    fastapi_app.add_middleware(
        CORSMiddleware,
        allow_origins=[o.strip() for o in cors_origins if o.strip()],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @fastapi_app.get("/health")
    async def health():
        return JSONResponse({"status": "healthy", "service": "{% endraw %}${{ values.name }}{% raw %}"})

    @fastapi_app.get("/info")
    async def service_info():
        from orchestrator.prompts import ROUTING_KEYWORDS
        from shared.config import SUB_AGENT_URL
        return {
            "service": PROJECT_NAME,
            "role": "orchestrator",
            "copilotkit": {% endraw %}${{ "True" if values.enableCopilotKit else "False" }}{% raw %},
            "sub_agents": [
                {
                    "name": "{% endraw %}${{ values.subAgentName }}{% raw %}",
                    "url": SUB_AGENT_URL,
                    "keywords": ROUTING_KEYWORDS,
                }
            ],
        }
{% endraw %}
{%- if values.enableAuth %}
{% raw %}

    # --- Auth endpoints ---

    @fastapi_app.post("/auth/register", response_model=AuthResponse)
    async def register(req: AuthRequest, request: Request):
        um: UserManager = request.app.state.user_manager
        try:
            user = um.create_user(req.username, req.password)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        token = create_jwt(user.user_id, user.username)
        return AuthResponse(token=token, user_id=user.user_id, username=user.username)

    @fastapi_app.post("/auth/login", response_model=AuthResponse)
    async def login(req: AuthRequest, request: Request):
        um: UserManager = request.app.state.user_manager
        user = um.authenticate(req.username, req.password)
        if not user:
            raise HTTPException(status_code=401, detail="Invalid username or password")
        token = create_jwt(user.user_id, user.username)
        return AuthResponse(token=token, user_id=user.user_id, username=user.username)

    @fastapi_app.get("/auth/me")
    async def auth_me(auth: AuthInfo = Depends(verify_auth)):
        if not auth.user_id:
            raise HTTPException(status_code=401, detail="JWT authentication required")
        return JSONResponse({"user_id": auth.user_id, "username": auth.username})
{% endraw %}
{%- endif %}
{% raw %}

    # --- Query endpoint ---

    @fastapi_app.post("/invoke", response_model=InvokeResponse)
    def invoke(request: InvokeRequest{% endraw %}{%- if values.enableAuth %}{% raw %}, auth: AuthInfo = Depends(verify_auth){% endraw %}{%- endif %}{% raw %}):
        logger.info(f"Received query: {request.query[:100]}")
        try:
            from orchestrator.flow import OrchestratorFlow
{% endraw %}
{%- if values.enableSessions %}
{% raw %}
            context_id = request.context_id or str(uuid.uuid4())
            query_text = request.query
            if request.context_id:
                try:
                    mgr: SessionManager = fastapi_app.state.session_manager
                    context = mgr.build_conversation_context(context_id)
                    if context:
                        query_text = context + request.query
                except Exception as e:
                    logger.warning(f"Failed to load session context: {e}")
{% endraw %}
{%- else %}
{% raw %}
            query_text = request.query
{% endraw %}
{%- endif %}
{% raw %}

            flow = OrchestratorFlow()
            flow.state.query = query_text
            result = flow.kickoff()
            result_text = str(result)
{% endraw %}
{%- if values.enableSessions %}
{% raw %}

            if request.context_id:
                try:
                    mgr: SessionManager = fastapi_app.state.session_manager
                    mgr.append_messages(
                        session_id=context_id,
                        user_msg=request.query,
                        assistant_msg=result_text,
                    )
                except Exception as e:
                    logger.warning(f"Failed to persist session {context_id}: {e}")

            return InvokeResponse(result=result_text, route=flow.state.route, context_id=context_id)
{% endraw %}
{%- else %}
{% raw %}
            return InvokeResponse(result=result_text, route=flow.state.route)
{% endraw %}
{%- endif %}
{% raw %}
        except Exception as e:
            logger.error(f"Error processing query: {e}")
            raise HTTPException(status_code=500, detail=str(e))
{% endraw %}
{%- if values.enableCopilotKit %}
{% raw %}

    # --- CopilotKit AG-UI endpoint ---
    if _HAS_AG_UI:
        @fastapi_app.post("/copilotkit")
        async def copilotkit(request: Request{% endraw %}{%- if values.enableAuth %}{% raw %}, auth: AuthInfo = Depends(verify_auth){% endraw %}{%- endif %}{% raw %}):
            return await copilotkit_handler(request{% endraw %}{%- if values.enableAuth %}{% raw %}, auth{% endraw %}{%- endif %}{% raw %})
{% endraw %}
{%- endif %}
{%- if values.enableSessions %}
{% raw %}

    # --- Session endpoints ---

    @fastapi_app.post("/sessions/{session_id}", status_code=201)
    async def init_session(session_id: str{% endraw %}{%- if values.enableAuth %}{% raw %}, auth: AuthInfo = Depends(verify_auth){% endraw %}{%- endif %}{% raw %}):
        mgr: SessionManager = fastapi_app.state.session_manager
        session = mgr.get_or_create_session(session_id)
        return JSONResponse(session.to_summary(), status_code=201)

    @fastapi_app.get("/sessions")
    async def list_sessions({% endraw %}{%- if values.enableAuth %}{% raw %}auth: AuthInfo = Depends(verify_auth){% endraw %}{%- endif %}{% raw %}):
        mgr: SessionManager = fastapi_app.state.session_manager
        return JSONResponse(mgr.list_sessions({% endraw %}{%- if values.enableAuth %}{% raw %}user_id=auth.user_id{% endraw %}{%- endif %}{% raw %}))

    @fastapi_app.get("/sessions/{session_id}")
    async def get_session(session_id: str{% endraw %}{%- if values.enableAuth %}{% raw %}, auth: AuthInfo = Depends(verify_auth){% endraw %}{%- endif %}{% raw %}):
        mgr: SessionManager = fastapi_app.state.session_manager
        session = mgr.get_session(session_id{% endraw %}{%- if values.enableAuth %}{% raw %}, user_id=auth.user_id{% endraw %}{%- endif %}{% raw %})
        if session is None:
            raise HTTPException(status_code=404, detail="Session not found")
        return JSONResponse(session.to_dict())

    @fastapi_app.delete("/sessions/{session_id}", status_code=204)
    async def delete_session(session_id: str{% endraw %}{%- if values.enableAuth %}{% raw %}, auth: AuthInfo = Depends(verify_auth){% endraw %}{%- endif %}{% raw %}):
        mgr: SessionManager = fastapi_app.state.session_manager
        if not mgr.delete_session(session_id{% endraw %}{%- if values.enableAuth %}{% raw %}, user_id=auth.user_id{% endraw %}{%- endif %}{% raw %}):
            raise HTTPException(status_code=404, detail="Session not found")
{% endraw %}
{%- endif %}
{% raw %}

    # --- A2A server ---
    agent_card = _build_agent_card()
    executor = OrchestratorExecutor()
    task_store = InMemoryTaskStore()
    handler = DefaultRequestHandler(
        agent_executor=executor,
        task_store=task_store,
    )
    a2a_app = A2AStarletteApplication(
        agent_card=agent_card,
        http_handler=handler,
    )
    fastapi_app.mount("/", a2a_app.build())

    logger.info(f"Orchestrator ready: {agent_card.url}")
    return fastapi_app


app = create_app()
{% endraw %}
