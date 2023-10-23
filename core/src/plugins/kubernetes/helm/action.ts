/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { DeployActionDefinition } from "../../../plugin/action-types"
import { dedent } from "../../../util/string"
import { KubernetesPluginContext } from "../config"
import { getPortForwardHandler } from "../port-forward"
import { getActionNamespace } from "../namespace"
import { HelmDeployAction, helmDeploySchema } from "./config"
import { deleteHelmDeploy, helmDeploy } from "./deployment"
import { execInHelmDeploy } from "./exec"
import { getHelmDeployLogs } from "./logs"
import { getHelmDeployStatus } from "./status"
import { posix } from "path"
import { k8sContainerStopSync } from "../container/sync"
import { helmGetSyncStatus, helmStartSync } from "./sync"
import { makeDocsLink } from "../../../docs/common"

export const getHelmDeployDocs = () => dedent`
  Specify a Helm chart (either in your repository or remote from a registry) to deploy.

  Refer to the [Helm guide](${makeDocsLink`k8s-plugins/action-types/deploy/helm`}) for usage instructions.
`

export const helmDeployDefinition = (): DeployActionDefinition<HelmDeployAction> => ({
  name: "helm",
  docs: getHelmDeployDocs(),
  schema: helmDeploySchema(),
  // outputsSchema: helmDeployOutputsSchema(),
  handlers: {
    deploy: helmDeploy,
    delete: deleteHelmDeploy,
    exec: execInHelmDeploy,
    getLogs: getHelmDeployLogs,
    getStatus: getHelmDeployStatus,

    startSync: helmStartSync,
    stopSync: k8sContainerStopSync,
    getSyncStatus: helmGetSyncStatus,

    getPortForward: async (params) => {
      const { ctx, log, action } = params
      const k8sCtx = <KubernetesPluginContext>ctx
      const namespace = await getActionNamespace({
        ctx: k8sCtx,
        log,
        action,
        provider: k8sCtx.provider,
        skipCreate: true,
      })
      return getPortForwardHandler({ ...params, namespace })
    },

    configure: async ({ config }) => {
      const chartPath = config.spec.chart?.path
      const containsSources = !!chartPath

      // Automatically set the include if not explicitly set
      if (chartPath && !(config.include || config.exclude)) {
        const valueFiles = config.spec.valueFiles || []
        config.include = containsSources
          ? ["*", "charts/**/*", "templates/**/*", ...valueFiles]
          : ["*.yaml", "*.yml", ...valueFiles]

        config.include = config.include.map((path) => posix.join(chartPath, path))
      }

      return { config, supportedModes: { sync: !!config.spec.sync, local: !!config.spec.localMode } }
    },
  },
})
