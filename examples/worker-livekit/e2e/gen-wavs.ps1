# E2E (opt-in): render the synthetic help-desk questions with the built-in Windows speech engine.
# Usage: powershell -File e2e/gen-wavs.ps1 -OutDir <dir>
param([Parameter(Mandatory = $true)][string]$OutDir)
Add-Type -AssemblyName System.Speech
New-Item -ItemType Directory -Force $OutDir | Out-Null
$phrases = [ordered]@{
  hours    = 'What are your opening hours?'
  returns  = 'How do I return an item?'
  warranty = 'Is there a warranty on appliances?'
  goodbye  = 'That is all, goodbye.'
}
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($k in $phrases.Keys) {
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $s.SelectVoice('Microsoft Zira Desktop')
  $s.SetOutputToWaveFile((Join-Path $OutDir "$k.wav"), $fmt)
  $s.Speak($phrases[$k])
  $s.Dispose()
  Write-Output "$k.wav"
}
