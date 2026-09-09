<#
.SYNOPSIS
  Crea la estructura de labs:
  labs/labN/img + labs/labN/labN.md con front-matter base.

.USO (desde la raíz del repositorio, donde está la carpeta labs/):

  # Crear 5 labs (lab1..lab5)
  .\scripts\create_labs.ps1 -TotalLabs 5

  # También funciona por posición:
  .\scripts\create_labs.ps1 5

.NOTAS
  - Si PowerShell bloquea el script, en esa sesión puedes ejecutar:
      Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#>

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [int]$TotalLabs
)

$RootDir = "labs"

if (-not (Test-Path $RootDir)) {
    New-Item -ItemType Directory -Path $RootDir | Out-Null
}

for ($i = 1; $i -le $TotalLabs; $i++) {
    $labDir = Join-Path $RootDir "lab$i"
    $imgDir = Join-Path $labDir "img"
    $mdFile = Join-Path $labDir "lab$i.md"

    # Rutas prev/next automáticas
    if ($i -eq 1) {
        $prevPath = "/"
    }
    else {
        $prevNum = $i - 1
        $prevPath = "/lab$prevNum/lab$prevNum/"
    }

    if ($i -eq $TotalLabs) {
        $nextPath = "/"
    }
    else {
        $nextNum = $i + 1
        $nextPath = "/lab$nextNum/lab$nextNum/"
    }

    Write-Host "Creando estructura para $labDir ..."
    New-Item -ItemType Directory -Force -Path $imgDir | Out-Null

    if (Test-Path $mdFile) {
        Write-Host "  -> $mdFile ya existe, se deja igual."
        continue
    }

    $content = @"
---
layout: lab
title: ""Práctica $i: CAMBIAR_AQUI_NOMBRE_DE_LA_PRACTICA"" # CAMBIAR POR CADA PRACTICA
permalink: /lab$i/lab$i/ # CAMBIAR POR CADA PRACTICA
images_base: /labs/lab$i/img # CAMBIAR POR CADA PRACTICA
duration: ""25 minutos"" # CAMBIAR POR CADA PRACTICA
objective: # CAMBIAR POR CADA PRACTICA
  - OBJECTIVO_DE_LA_PRACTICA
prerequisites: # CAMBIAR POR CADA PRACTICA
  - PREREQUISITO_1
  - PREREQUISITO_2
  - PREREQUISITO_3
  - PREREQUISITO_4
  - PREREQUISITO_X
introduction: # CAMBIAR POR CADA PRACTICA
  - INTRODUCCIÓN_DE_LA_PRACTICA
slug: lab$i # CAMBIAR POR CADA PRACTICA
lab_number: $i # CAMBIAR POR CADA PRACTICA
final_result: > # CAMBIAR POR CADA PRACTICA
  RESULTADO_FINAL_ESPERADO_DE_LA_PRACTICA
notes: # CAMBIAR POR CADA PRACTICA
  - NOTAS_CONSIDERACIONES_ADICIONALES
  - NOTAS_CONSIDERACIONES_ADICIONALES
references: # CAMBIAR POR CADA PRACTICA LINKS ADICIONALES DE DOCUMENTACION
  - text: Documentación oficial de Terraform
    url: https://developer.hashicorp.com/terraform
  - text: Documentación de Azure CLI
    url: https://learn.microsoft.com/es-es/cli/azure/
prev: $prevPath # CAMBIAR POR CADA PRACTICA MENU DE NAVEGACION HACIA ATRAS        
next: $nextPath # CAMBIAR POR CADA PRACTICA MENU DE NAVEGACION HACIA ADELANTE
---

# Práctica $i: CAMBIAR_AQUI_NOMBRE_DE_LA_PRACTICA

> Aquí va la introducción ampliada de la práctica.

## Objetivos

- OBJECTIVO_DE_LA_PRACTICA

## Prerrequisitos

- PREREQUISITO_1
- PREREQUISITO_2
- PREREQUISITO_3
- PREREQUISITO_4
- PREREQUISITO_X

## Desarrollo de la práctica

<!-- Aquí comienzan las instrucciones paso a paso de la práctica -->
"@

    $content | Set-Content -Path $mdFile -Encoding UTF8
    Write-Host "  -> Creado $mdFile"
}

Write-Host "Listo. Se generaron / actualizaron labs en '$RootDir'."
