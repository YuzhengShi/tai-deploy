# A spoken sentence as a WAV file the voice smoke test can play into a call: 16 kHz, 16-bit, mono (what the page's microphone side sends).
# Windows' own speech engine speaks it, so the "student" is the same every run and no person has to talk. Used by:
#   bash deploy/cs6650/tai_live.sh smoke voice [chat|interview]
param(
  [string]$Text = 'Hello. Can you explain in one sentence how Raft elects a leader?',
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Voice = ''
)
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  if ($Voice) { $synth.SelectVoice($Voice) }
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $synth.SetOutputToWaveFile($Out, $format)
  $synth.Speak($Text)
} finally {
  $synth.Dispose()
}
Write-Output ("wrote " + $Out + " (" + (Get-Item $Out).Length + " bytes)")
