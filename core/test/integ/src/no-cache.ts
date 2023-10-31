// test action version changes

import { expect } from "chai"
import { cloneDeep } from "lodash"
import { Garden } from "../../../src"
import { ConfigGraph } from "../../../src/graph/config-graph"
import { PluginContext } from "../../../src/plugin-context"
import { KubernetesProvider } from "../../../src/plugins/kubernetes/config"
import { KubernetesDeployAction } from "../../../src/plugins/kubernetes/kubernetes-type/config"
import { getDataDir, makeTestGarden } from "../../helpers"

describe("noCache", () => {
  let cleanup: (() => void) | undefined
  let garden1: Garden
  let graph1: ConfigGraph
  let provider1: KubernetesProvider
  let ctx1: PluginContext
  let garden2: Garden
  let graph2: ConfigGraph
  let provider2: KubernetesProvider
  let ctx2: PluginContext

  after(async () => {
    if (garden1) {
      garden1.close()
    }
    if (garden2) {
      garden2.close()
    }
  })

  before(async () => {
    // env 1
    const projectRoot = getDataDir("test-projects", "actions-no-cache")
    garden1 = await makeTestGarden(projectRoot, { environmentString: "local1" })
    provider1 = (await garden1.resolveProvider(garden1.log, "local-kubernetes")) as KubernetesProvider
    ctx1 = await garden1.getPluginContext({ provider: provider1, templateContext: undefined, events: undefined })
    graph1 = await garden1.getConfigGraph({ log: garden1.log, emit: false })
    // env 2
    garden2 = await makeTestGarden(projectRoot, { environmentString: "local2" })
    provider2 = (await garden2.resolveProvider(garden2.log, "local-kubernetes")) as KubernetesProvider
    ctx2 = await garden2.getPluginContext({ provider: provider2, templateContext: undefined, events: undefined })
    graph2 = await garden2.getConfigGraph({ log: garden2.log, emit: false })
  })

  it("should find keys to ignore for action version calculation from action config", async () => {
    const unresolvedAction1 = graph1.getDeploy("test-deploy-container")
    const unresolvedAction2 = graph1.getDeploy("test-deploy-container-with-merge")
    const resolvedAction1 = await garden1.resolveAction<KubernetesDeployAction>(
      {
        action: unresolvedAction1,
        log: garden1.log,
        graph: graph1,
      }
    )
    const resolvedAction2 = await garden1.resolveAction<KubernetesDeployAction>(
      {
        action: unresolvedAction2,
        log: garden1.log,
        graph: graph1,
      }
    )
    expect(resolvedAction1.ignoredKeysForVersion).to.have.members([
      "noCache.variables.0",
      "spec.ingresses.0.hostname"
    ])
    expect(resolvedAction2.ignoredKeysForVersion).to.have.members([
      "noCache.variables.0",
      "noCache.variables.1",
      "spec.ingresses.0.hostname",
      "spec.env.EXTERNAL_API_URL"
    ])
  })

  context("across the environments", () => {
    it("should not change action version, if an ignored variable changes", async () => {
      const unresolvedAction1 = cloneDeep(graph1.getDeploy("test-deploy-container"))
      const unresolvedAction2 = cloneDeep(graph2.getDeploy("test-deploy-container"))

      const resolvedAction1 = await garden1.resolveAction<KubernetesDeployAction>(
        {
          action: unresolvedAction1,
          log: garden1.log,
          graph: graph1,
        }
      )

      const resolvedAction2 = await garden2.resolveAction<KubernetesDeployAction>(
        {
          action: unresolvedAction2,
          log: garden2.log,
          graph: graph2,
        }
      )

      expect(resolvedAction1.versionString()).to.eql(resolvedAction2.versionString())
    })

    it("should not change action version, if an ignored variable changes inside $merge", async () => {
      const unresolvedAction1 = cloneDeep(graph1.getDeploy("test-deploy-container-with-merge"))
      const unresolvedAction2 = cloneDeep(graph2.getDeploy("test-deploy-container-with-merge"))

      const resolvedAction1 = await garden1.resolveAction<KubernetesDeployAction>(
        {
          action: unresolvedAction1,
          log: garden1.log,
          graph: graph1,
        }
      )

      const resolvedAction2 = await garden2.resolveAction<KubernetesDeployAction>(
        {
          action: unresolvedAction2,
          log: garden2.log,
          graph: graph2,
        }
      )

      expect(resolvedAction1.versionString()).to.eql(resolvedAction2.versionString())

    })
  })
})
