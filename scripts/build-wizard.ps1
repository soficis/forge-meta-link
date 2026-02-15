$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..")
$WizardArgs = $args

Set-Location $RepoRoot

$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($null -ne $NodeCmd) {
    & node .\scripts\build-wizard.mjs @WizardArgs
    exit $LASTEXITCODE
}

cmd.exe /c "node scripts\build-wizard.mjs $($WizardArgs -join ' ')"
exit $LASTEXITCODE
