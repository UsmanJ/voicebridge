# LIVE HARNESS (opt-in): render synthetic test utterances with the built-in Windows speech engine.
# Output: 16 kHz, 16-bit, mono WAV files. Usage: powershell -File gen-wavs.ps1 -OutDir <dir>
param([Parameter(Mandatory = $true)][string]$OutDir)
Add-Type -AssemblyName System.Speech
New-Item -ItemType Directory -Force $OutDir | Out-Null
$phrases = [ordered]@{
  hello     = 'Hello there. What can you do for me today?'
  slow      = 'Please run the slow request for me.'
  stubborn  = 'Please run the stubborn request for me.'
  quick     = 'Quick question about the opening hours.'
  story     = 'Please tell me a long story.'
  stop      = 'Wait. Stop please. Different question.'
  error     = 'Please trigger an error.'
  timeout   = 'Please trigger a timeout.'
  marker7   = 'Please record marker number seven.'
  marker3   = 'Please record marker number three'
  marker9   = 'actually no, make it marker number nine.'
}
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($k in $phrases.Keys) {
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $s.SelectVoice('Microsoft Zira Desktop')
  $s.Rate = 0
  $path = Join-Path $OutDir "$k.wav"
  $s.SetOutputToWaveFile($path, $fmt)
  $s.Speak($phrases[$k])
  $s.Dispose()
  Write-Output "$k -> $path"
}
