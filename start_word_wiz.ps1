# Word Wiz for Kids - One-click launcher with portable Python/venv (Windows PowerShell)
param(
  [int]$Port = 8080
)

$ErrorActionPreference = 'Stop'

function Write-Info($msg){ Write-Host "[INFO] $msg" -ForegroundColor Cyan }
function Write-Warn($msg){ Write-Host "[WARN] $msg" -ForegroundColor Yellow }

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
if(Test-Path "$root/Demo2/index.html"){ Set-Location "$root/Demo2" }

$cwd = Get-Location

# Preferred: use local venv if exists
$venvPython = Join-Path $root '.venv\Scripts\python.exe'
if(-not (Test-Path $venvPython)){
  # Try to create venv from system python
  $sysPy = Get-Command python -ErrorAction SilentlyContinue
  if($sysPy){
    Write-Info "创建本地虚拟环境 .venv ..."
    & python -m venv "$root/.venv"
  } else {
    # Fallback: download embeddable portable Python and use directly
    $portableDir = Join-Path $root '.portable-python'
    $portablePython = Join-Path $portableDir 'python.exe'
    if(-not (Test-Path $portablePython)){
      Write-Info "下载便携式 Python（一次性）..."
      New-Item -ItemType Directory -Force -Path $portableDir | Out-Null
      $url = 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip'
      $zip = Join-Path $portableDir 'python-embed.zip'
      Invoke-WebRequest $url -OutFile $zip -UseBasicParsing
      Expand-Archive -Path $zip -DestinationPath $portableDir -Force
      Remove-Item $zip -Force
      $pth = Get-ChildItem -Path $portableDir -Filter '*.pth' | Select-Object -First 1
      if($pth){ Add-Content -Path $pth.FullName -Value 'import site' }
    }
    $venvPython = $portablePython
    Write-Warn "未检测到系统 Python，将使用便携式 Python 运行（无需安装）。"
  }
}

if(-not (Test-Path $venvPython)){
  throw "未能获取可用的 Python 解释器。"
}

Write-Info "启动本地服务器: http://localhost:$Port/"
Start-Process -FilePath $venvPython -ArgumentList "-m http.server $Port -d `"$($cwd.Path)`"" -WorkingDirectory $cwd.Path -WindowStyle Normal -PassThru | Out-Null
Start-Process "http://localhost:$Port/"

Write-Info "服务器已启动。关闭打开的命令行窗口即可停止。"

