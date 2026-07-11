/**
 * An artificial Service-lens domain (`backend`, `analytics`, …). The distinct React Flow type keeps
 * its semantic role explicit while delegating every visual and interaction affordance to the same
 * group-container view used by real Map packages and directories.
 */

import { memo } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import type { ModuleGroupData } from "../../../derive/moduleTree";
import { GroupContainerNodeView } from "./PackageOverviewNode";

type ServiceDomainRfNode = Node<ModuleGroupData, "serviceDomain">;

function ServiceDomainNodeImpl({ id, data }: NodeProps<ServiceDomainRfNode>) {
  return <GroupContainerNodeView id={id} data={data} />;
}

export const ServiceDomainNode = memo(ServiceDomainNodeImpl);
