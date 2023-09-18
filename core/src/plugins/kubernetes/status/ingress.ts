/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { ServiceIngress, ServiceProtocol } from "../../../types/service"
import { KubernetesProvider } from "../config"
import { isProviderGardenKubernetes } from "../garden-kubernetes/garden-kubernetes"
import { KubernetesIngress, KubernetesResource } from "../types"

/**
 * Returns a list of ServiceIngresses found in a list of k8s resources.
 *
 * Does a best-effort extraction based on known ingress resource types.
 */
export function getK8sIngresses(resources: KubernetesResource[], provider?: KubernetesProvider): ServiceIngress[] {
  const output: ServiceIngress[] = []

  for (const r of resources.filter(isIngressResource)) {
    const tlsHosts = r.spec.tls?.flatMap((t) => t.hosts || []) || []

    for (const rule of r.spec.rules || []) {
      if (!rule.host) {
        continue
      }

      // TODO: handle wildcards more specifically
      for (const path of rule.http?.paths || []) {
        let stringPath: string

        if (typeof path !== "string") {
          // Handle extensions/v1beta1
          if (!path.path) {
            // There should always be a path, but the type doesn't guarantee it, skip if missing
            continue
          }
          stringPath = path.path
        } else {
          stringPath = path
        }

        let protocol: ServiceProtocol = tlsHosts.includes(rule.host) ? "https" : "http"
        // garden-kubernetes ingresses should always be https
        if (provider && isProviderGardenKubernetes(provider)) {
          protocol = "https"
        }

        output.push({
          hostname: rule.host,
          protocol,
          path: stringPath,
        })
      }
    }
  }

  return output
}

export function isIngressResource(resource: KubernetesResource): resource is KubernetesIngress {
  if (resource.kind === "Ingress") {
    if (
      resource.apiVersion === "networking.k8s.io/v1" ||
      resource.apiVersion === "networking.k8s.io/v1beta1" ||
      resource.apiVersion === "extensions/v1beta1"
    ) {
      return true
    }
  }
  return false
}
