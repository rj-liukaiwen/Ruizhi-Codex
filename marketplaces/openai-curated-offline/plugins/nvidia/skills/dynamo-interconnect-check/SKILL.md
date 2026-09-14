---
name: dynamo-interconnect-check
description: Validate that a Dynamo deployment's NIXL/UCX/NCCL interconnect is ready for disaggregated serving over RDMA/NVLink. Use after recipe-runner brings a deployment up (especially disagg/multi-node) to confirm the KV transport is correct; use troubleshoot for diagnosing already-failed pods.
---

# NVIDIA: dynamo-interconnect-check

Validate that a Dynamo deployment's NIXL/UCX/NCCL interconnect is ready for disaggregated serving over RDMA/NVLink. Use after recipe-runner brings a deployment up (especially disagg/multi-node) to confirm the KV transport is correct; use troubleshoot for diagnosing already-failed pods.

If this workflow requires an account-backed connector, use the installed app/connector for NVIDIA. If authorization is missing, ask the user to connect NVIDIA before taking account actions.
