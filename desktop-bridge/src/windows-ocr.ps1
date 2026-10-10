# Loaded lazily in the persistent worker; Windows' local OCR engine needs an installed language.
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null=[Windows.Storage.Streams.DataWriter,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime]
$script:seekAsTask=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {$_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetGenericArguments().Count -eq 1} | Select-Object -First 1
function Wait-SeekWinRT($operation,[Type]$resultType){$task=$script:seekAsTask.MakeGenericMethod($resultType).Invoke($null,@($operation));if(!$task.Wait(5000)){throw 'Windows text recognition timed out'};$task.GetAwaiter().GetResult()}
function Read-SeekScreenText($command){
 $engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages();if(!$engine){throw 'Install a Windows OCR language in Settings > Time & language > Language & region'}
 $stream=New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
 $writer=New-Object Windows.Storage.Streams.DataWriter($stream)
 $bitmap=$null
 try{
  $writer.WriteBytes([Convert]::FromBase64String([string]$command.image))
  $null=Wait-SeekWinRT ($writer.StoreAsync()) ([uint32]);$stream.Seek(0)
  $decoder=Wait-SeekWinRT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap=Wait-SeekWinRT ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  if($bitmap.PixelWidth -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension -or $bitmap.PixelHeight -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension){throw 'Screen capture exceeds Windows OCR size limit'}
  $result=Wait-SeekWinRT ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $count=0
  foreach($line in $result.Lines){
   if($count -ge 200){break};$words=@($line.Words);if(!$words.Count){continue}
   $left=($words.BoundingRect.X | Measure-Object -Minimum).Minimum;$top=($words.BoundingRect.Y | Measure-Object -Minimum).Minimum
   $right=($words | ForEach-Object {$_.BoundingRect.X+$_.BoundingRect.Width} | Measure-Object -Maximum).Maximum
   $bottom=($words | ForEach-Object {$_.BoundingRect.Y+$_.BoundingRect.Height} | Measure-Object -Maximum).Maximum
   $x=[double]$command.x+$left*[double]$command.width/$bitmap.PixelWidth;$y=[double]$command.y+$top*[double]$command.height/$bitmap.PixelHeight
   $width=($right-$left)*[double]$command.width/$bitmap.PixelWidth;$height=($bottom-$top)*[double]$command.height/$bitmap.PixelHeight
   $id='ocr'+(++$count);[SeekAccessibility]::SetOcr($id,$x,$y,$width,$height)
   @{id=$id;name=$line.Text;role='ScreenText';source='ocr';x=$x;y=$y;width=$width;height=$height;enabled=$true;focused=$false;password=$false;canInvoke=$false;canFill=$false}
  }
 }finally{if($bitmap){$bitmap.Dispose()};$writer.DetachStream()|Out-Null;$writer.Dispose();$stream.Dispose()}
}
