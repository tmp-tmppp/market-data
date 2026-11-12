{{/* Name of every object of the release. */}}
{{- define "market-data.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Labels that select the Pods; never change them after the first install (selectors are immutable). */}}
{{- define "market-data.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Labels on every object. */}}
{{- define "market-data.labels" -}}
{{ include "market-data.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.image.tag | trunc 63 | trimSuffix "-" | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* Restricted security context of every container. */}}
{{- define "market-data.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end -}}

{{/* Name of the ConfigMap with the runtime configuration file (kept apart from the environment ConfigMap). */}}
{{- define "market-data.runtimeConfigMap" -}}
{{ include "market-data.fullname" . }}-runtime
{{- end -}}

{{/* The directory the runtime ConfigMap is mounted at, and the file in it that RUNTIME_CONFIG_FILE names. */}}
{{- define "market-data.runtimeDir" -}}
/etc/market-data/runtime
{{- end -}}

{{- define "market-data.runtimeFile" -}}
{{ include "market-data.runtimeDir" . }}/runtime.env
{{- end -}}
