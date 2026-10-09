# OrgX tool inventory before and after

Comparison baseline: `44d18580ea5f9f9e030f6f47fdf7cf7d2895e793`, the source before this operation refactor. The historical ChatGPT profile advertised 28 descriptors; the default v2 profile advertised 46. The proposed ChatGPT/default/directory profile advertises 48 descriptors: 40 core workflow and receipt operations, one plan-edit journal operation, and seven app-only callbacks. Scopes still constrain the actual authenticated inventory.

This is a coordinated cutover. Deploy the core services, deploy MCP, update affected client packages and their instructions, then reconnect hosts to refresh tools and widgets. There is no required quiet period or historical session inventory. Native execution reporting and independent local MCP servers remain separate contracts.

## Before: ChatGPT profile

- `orgx_bootstrap`
- `orgx_search`
- `orgx_inspect`
- `orgx_recommend`
- `orgx_write`
- `orgx_attach`
- `orgx_act`
- `manage_lifecycle`
- `orgx_plan`
- `orgx_spawn`
- `orgx_decide`
- `orgx_submit_receipt`
- `approve_decision`
- `reject_decision`
- `orgx_widget_decide`
- `orgx_command_status`
- `orgx_panel_snapshot`
- `orgx_widget_receipt_call`
- `get_agent_status`
- `get_initiative_pulse`
- `scaffold_initiative`
- `handoff_task`
- `approve_agent_work`
- `review_artifact`
- `get_morning_brief`
- `get_operator_chronicle`
- `check_execution_readiness`
- `resume_agent_run`

## Before: full default v2 profile

- `orgx_bootstrap`
- `orgx_tail`
- `orgx_search`
- `orgx_inspect`
- `orgx_controller_status`
- `orgx_recommend`
- `orgx_write`
- `orgx_attach`
- `orgx_act`
- `manage_lifecycle`
- `orgx_plan`
- `orgx_spawn`
- `orgx_decide`
- `orgx_expect`
- `orgx_submit_receipt`
- `orgx_emit_activity`
- `orgx_request_attention`
- `orgx_poll_attention`
- `orgx_ack_attention`
- `orgx_request_question`
- `orgx_poll_question`
- `orgx_emit_execution_graph`
- `approve_decision`
- `reject_decision`
- `orgx_widget_decide`
- `orgx_command_status`
- `orgx_panel_snapshot`
- `orgx_widget_receipt_call`
- `get_agent_status`
- `get_initiative_pulse`
- `scaffold_initiative`
- `spawn_agent_task`
- `handoff_task`
- `recommend_next_action`
- `query_org_memory`
- `recall_memory`
- `approve_agent_work`
- `delegate_agent_task`
- `track_project_progress`
- `review_artifact`
- `get_morning_brief`
- `get_operator_chronicle`
- `check_execution_readiness`
- `consolidate_pr`
- `request_independent_artifact_review`
- `resume_agent_run`

## After: model-callable tools

| Tool | Purpose |
| --- | --- |
| `orgx_get_workspace_context` | Read OrgX Workspace Context |
| `orgx_search` | Search OrgX |
| `orgx_inspect` | Inspect OrgX Work |
| `orgx_get_operator_brief` | Read OrgX Operator Brief |
| `orgx_get_next_actions` | Get OrgX Next Actions |
| `orgx_get_agent_status` | Read OrgX Agent Status |
| `orgx_get_initiative_progress` | Read OrgX Initiative Progress |
| `orgx_get_operation_status` | Read OrgX Operation Status |
| `orgx_check_execution_readiness` | Check OrgX Execution Readiness |
| `orgx_start_plan` | Start OrgX Plan |
| `orgx_read_plan` | Read OrgX Plan |
| `orgx_save_plan` | Save OrgX Plan |
| `orgx_complete_plan` | Complete OrgX Plan |
| `orgx_validate_initiative_plan` | Validate OrgX Initiative Plan |
| `orgx_create_initiative_hierarchy` | Create OrgX Initiative Hierarchy |
| `orgx_create_initiative` | Create OrgX Initiative |
| `orgx_create_workstream` | Create OrgX Workstream |
| `orgx_create_milestone` | Create OrgX Milestone |
| `orgx_create_task` | Create OrgX Task |
| `orgx_update_work` | Update OrgX Work Content |
| `orgx_estimate_agent_task` | Estimate OrgX Agent Task |
| `orgx_start_agent_task` | Start OrgX Agent Task |
| `orgx_handoff_task` | Hand Off OrgX Task |
| `orgx_launch_initiative` | Launch OrgX Initiative |
| `orgx_pause_work` | Pause OrgX Work |
| `orgx_resume_work` | Resume OrgX Work |
| `orgx_retry_work` | Retry OrgX Work |
| `orgx_cancel_work` | Cancel OrgX Work |
| `orgx_capture_decision` | Capture OrgX Decision |
| `orgx_list_pending_decisions` | List Pending OrgX Decisions |
| `orgx_open_decision_review` | Open OrgX Decision Review |
| `orgx_attach_artifact` | Attach OrgX Artifact |
| `orgx_open_artifact_review` | Open OrgX Artifact Review |
| `orgx_request_independent_artifact_review` | Request Independent OrgX Artifact Review |
| `orgx_complete_work_with_proof` | Complete OrgX Work With Proof |
| `orgx_submit_work_receipt` | Submit OrgX Work Receipt |
| `orgx_validate_work_receipt` | Validate OrgX Work Receipt |
| `orgx_get_work_receipt` | Get OrgX Work Receipt |
| `orgx_list_work_receipts` | List OrgX Work Receipts |
| `orgx_get_receipt_review_queue` | Get OrgX Receipt Review Queue |
| `orgx_record_plan_edit` | Record OrgX Plan Edit Summary |

## After: app-only callbacks

| Tool | Purpose |
| --- | --- |
| `orgx_widget_decide` | Decide from the decisions widget |
| `orgx_panel_snapshot` | OrgX panel |
| `orgx_widget_receipt_call` | Your call on a work receipt |
| `resume_agent_run` | Resume Agent Run |
| `orgx_widget_select_workspace` | Select Workspace in OrgX Widget |
| `orgx_widget_approve_artifact` | Approve Artifact from OrgX Widget |
| `orgx_widget_request_artifact_changes` | Request Artifact Changes from OrgX Widget |

## What happens to the flagged tools

| Before | After |
| --- | --- |
| `approve_decision`, `reject_decision` | Models open a decision review with `orgx_open_decision_review`; a signed human widget click records the ruling. |
| `approve_agent_work`, `review_artifact` | Models open an artifact review with `orgx_open_artifact_review`; signed human clicks use `orgx_widget_approve_artifact` or `orgx_widget_request_artifact_changes`. |
| `manage_lifecycle`, `orgx_act` | `orgx_launch_initiative`, `orgx_pause_work`, `orgx_resume_work`, `orgx_retry_work`, `orgx_cancel_work`, and `orgx_complete_work_with_proof`; each has its own schema. |
| `orgx_write` | `orgx_create_initiative`, `orgx_create_workstream`, `orgx_create_milestone`, `orgx_create_task`, and `orgx_update_work`. |
| `orgx_plan` | `orgx_start_plan`, `orgx_read_plan`, `orgx_save_plan`, `orgx_complete_plan`, and `orgx_record_plan_edit`. |
| `orgx_spawn` | `orgx_estimate_agent_task`, `orgx_start_agent_task`, and `orgx_handoff_task`. |
| `orgx_decide` | `orgx_capture_decision`, `orgx_list_pending_decisions`, and `orgx_open_decision_review`. |
| `scaffold_initiative` | `orgx_validate_initiative_plan` and `orgx_create_initiative_hierarchy`; launch is separate. Provider review is still required for publication. |
| `orgx_submit_receipt` | Portable receipt lifecycle: `orgx_submit_work_receipt`, `orgx_validate_work_receipt`, `orgx_get_work_receipt`, `orgx_list_work_receipts`, and `orgx_get_receipt_review_queue`. Runtime reporting receipts remain a separate execution contract. |

Specialist operations are exposed through the explicit `extended` profile. Active runtime profiles can retain their native reporting commands; this does not expose the old routers to ChatGPT or directory models. Removing old ChatGPT descriptors does not remove internal service handlers or rename independent OpenClaw local tools.

## Additional tools in the extended profile

The extended profile adds these 20 model-callable tools to the default 48 descriptors. `orgx_record_plan_edit` already belongs to the default profile. Each has a fixed operation schema; none uses a generic action selector.

| Tool | Purpose |
| --- | --- |
| `orgx_create_and_launch_initiative_hierarchy` | Create and Launch OrgX Initiative Hierarchy |
| `orgx_request_plan_critique` | Request OrgX Plan Critique |
| `orgx_check_agent_delegation` | Check OrgX Agent Delegation |
| `orgx_classify_agent_task` | Classify OrgX Agent Task |
| `orgx_create_and_start_agent_task` | Create and Start OrgX Agent Task |
| `orgx_create_decision` | Create Named OrgX Decision |
| `orgx_open_decision_approval_review` | Open OrgX Decision Approval Review |
| `orgx_open_decision_rejection_review` | Open OrgX Decision Rejection Review |
| `orgx_start_work` | Start OrgX Work |
| `orgx_complete_entity` | Complete OrgX Entity |
| `orgx_archive_work` | Archive OrgX Work |
| `orgx_block_work` | Block OrgX Work |
| `orgx_unblock_work` | Unblock OrgX Work |
| `orgx_reopen_work` | Reopen OrgX Work |
| `orgx_flag_risk_work` | Flag OrgX Milestone Risk |
| `orgx_activate_work` | Activate OrgX Playbook |
| `orgx_reassign_streams_work` | Reassign OrgX Initiative Workstreams |
| `orgx_ship_batch_work` | Ship OrgX Milestone Task Batch |
| `orgx_delete_work` | Permanently Delete OrgX Work |
| `orgx_validate_studio_content` | Validate OrgX Studio Content |
