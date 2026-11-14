# The spoken test set of the voice lab (docs/VOICE_SELFBUILT.md section 9): every text of eval/voice-lab/testset.json as a 16 kHz, 16-bit, mono
# WAV for each voice, made by Windows' own speech engine (Microsoft David and Zira: the same "students" every run, no person has to talk).
# One file per (voice, text), named by a hash of "voice|text", and a manifest.json that maps "voice|text" to the file name. Deterministic: the
# same text and voice give the same samples. The clips keep the engine's own leading and trailing silence; the measuring client trims them and
# puts back the pauses the scenarios ask for, so that the end of speech is known to the sample.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File eval/voice-lab/make_audio.ps1 -TestSet eval/voice-lab/testset.json -OutDir <dir>
param(
  [Parameter(Mandatory = $true)][string]$TestSet,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [string[]]$Voices = @()
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

$set = Get-Content -Raw -Encoding UTF8 -LiteralPath $TestSet | ConvertFrom-Json
if ($Voices.Count -eq 0) { $Voices = @($set.voices) }

$texts = New-Object System.Collections.Generic.List[string]
function Add-Text([string]$t) { if ($t -and -not $texts.Contains($t)) { $texts.Add($t) } }
foreach ($r in $set.recognition) { Add-Text $r.text }
foreach ($l in $set.latency) { Add-Text $l.text }
foreach ($group in @($set.turntaking.tuning, $set.turntaking.eval, $set.modes.interview.eval, $set.modes.talk.eval)) {
  foreach ($s in $group) { foreach ($seg in $s.segments) { Add-Text $seg.text } }
}
Add-Text $set.bargein.ask
foreach ($i in @($set.bargein.tuning) + @($set.bargein.eval)) { Add-Text $i }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$sha = [System.Security.Cryptography.SHA1]::Create()
$manifest = [ordered]@{}
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)

foreach ($voice in $Voices) {
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  try {
    $synth.SelectVoice($voice)
    foreach ($t in $texts) {
      $key = "$voice|$t"
      $name = ([System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($key))).Replace('-', '').ToLower()).Substring(0, 12) + '.wav'
      $path = Join-Path $OutDir $name
      $synth.SetOutputToWaveFile($path, $format)
      $synth.Speak($t)
      $synth.SetOutputToNull()
      $manifest[$key] = $name
    }
  } finally {
    $synth.Dispose()
  }
}
$manifest | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $OutDir 'manifest.json')
Write-Output ("wrote " + $manifest.Count + " clips for " + $Voices.Count + " voice(s) to " + $OutDir)
