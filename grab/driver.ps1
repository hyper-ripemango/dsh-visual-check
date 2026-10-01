# dsh-visual-check driver -- calls into VisualGrab.cs and prints a line protocol.
#
# ASCII ONLY, INCLUDING COMMENTS. Windows PowerShell 5.1 reads a BOM-less UTF-8
# script as ANSI; non-ASCII comment bytes then get torn into quote-like glyphs
# and break parsing. This file deliberately contains no non-ASCII characters.
# (Same reason VisualGrab.cs is ASCII-only.)
#
# Parameters arrive through the environment (VG_*) instead of argv, so Node can
# pass arbitrary paths without quoting games.
#
# The compiled assembly is cached by source hash under VG_CACHE, because
# Add-Type recompiles on every process start (~1-2s) and this driver runs once
# per capture.
$ErrorActionPreference = 'Stop'

# Node reads our stdout as UTF-8, but PowerShell 5.1 encodes redirected output
# with [Console]::OutputEncoding, which defaults to the OEM code page (GBK on
# this machine). Without this line every non-ASCII window title arrives as
# mojibake -- and matching a window by its Chinese title then simply fails.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$csPath   = $env:VG_CS
$mode     = $env:VG_MODE
$out      = $env:VG_OUT
$cacheDir = $env:VG_CACHE
$maxPx    = if ($env:VG_MAXPIXELS) { [int]$env:VG_MAXPIXELS } else { 0 }
$handle   = if ($env:VG_HANDLE) { [int64]$env:VG_HANDLE } else { 0 }
$raise    = ($env:VG_RAISE -eq '1')
$x = if ($env:VG_X) { [int]$env:VG_X } else { 0 }
$y = if ($env:VG_Y) { [int]$env:VG_Y } else { 0 }
$w = if ($env:VG_W) { [int]$env:VG_W } else { 0 }
$h = if ($env:VG_H) { [int]$env:VG_H } else { 0 }

function Fail($message) {
    Write-Output ('ok=0')
    Write-Output ('error=' + ($message -replace "`r?`n", ' '))
    exit 7
}

try {
    if (-not (Test-Path $csPath)) { Fail "VisualGrab.cs not found at $csPath" }

    # ---- load or compile the helper once ------------------------------------
    $src = [System.IO.File]::ReadAllText($csPath, [System.Text.Encoding]::UTF8)
    if (-not ('VisualGrab' -as [type])) {
        $loaded = $false
        try {
            if ($cacheDir) {
                if (-not (Test-Path $cacheDir)) { New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null }
                $hash = (Get-FileHash -Path $csPath -Algorithm SHA256).Hash
                $dll = Join-Path $cacheDir ('VisualGrab-' + $hash + '.dll')
                if (Test-Path $dll) {
                    Add-Type -Path $dll -ErrorAction Stop
                    $loaded = $true
                } else {
                    Add-Type -TypeDefinition $src -Language CSharp -OutputAssembly $dll -OutputType Library -ErrorAction Stop
                    if (-not ('VisualGrab' -as [type])) { Add-Type -Path $dll -ErrorAction Stop }
                    $loaded = $true
                }
            }
        } catch {
            $loaded = $false
        }
        if (-not $loaded) {
            Add-Type -TypeDefinition $src -Language CSharp -ErrorAction Stop
        }
    }

    $null = [VisualGrab]::MakeDpiAware()
    Write-Output 'ok=1'

    switch ($mode) {
        'geometry' {
            Write-Output ('screen=' + [VisualGrab]::ScreenW() + 'x' + [VisualGrab]::ScreenH() + '+' + [VisualGrab]::ScreenX() + '+' + [VisualGrab]::ScreenY())
        }
        'foreground' {
            Write-Output ('handle=' + [VisualGrab]::ForegroundHandle())
        }
        'coverage' {
            if ($handle -eq 0) { Fail 'coverage needs VG_HANDLE' }
            Write-Output ('coverage=' + [VisualGrab]::SampleCoverage($handle))
        }
        'state' {
            if ($handle -eq 0) { Fail 'state needs VG_HANDLE' }
            # One key=value per LINE. The line protocol parses only the first '='
            # on each line, so emitting "exists=1;minimized=0;..." as a single line
            # would make every field after the first unreadable.
            foreach ($pair in ([VisualGrab]::WindowState($handle) -split ';')) {
                if ($pair) { Write-Output $pair }
            }
        }
        'pixel' {
            if ($handle -eq 0) { Fail 'pixel needs VG_HANDLE' }
            foreach ($pair in ([VisualGrab]::CentrePixel($handle) -split ';')) {
                if ($pair) { Write-Output $pair }
            }
        }
        'minimize' {
            if ($handle -eq 0) { Fail 'minimize needs VG_HANDLE' }
            Write-Output ('minimized=' + [VisualGrab]::MinimizeWindow($handle))
        }
        'activate' {
            if ($handle -eq 0) { Fail 'activate needs VG_HANDLE' }
            Write-Output ('activateLog=' + [VisualGrab]::Activate($handle))
            Write-Output ('foreground=' + [VisualGrab]::ForegroundHandle())
        }
        'list' {
            foreach ($win in [VisualGrab]::ListWindows()) {
                $fields = @(
                    'window',
                    $win.Handle, $win.Pid, $win.Process,
                    $win.X, $win.Y, $win.W, $win.H,
                    [int]$win.Foreground, [int]$win.Minimized, [int]$win.Overlay,
                    $win.Title
                )
                Write-Output ($fields -join "`t")
            }
        }
        'screen' {
            if (-not $out) { Fail 'screen needs VG_OUT' }
            $info = [VisualGrab]::CaptureRegion($out, 0, 0, 0, 0, $maxPx)
            Write-Output ('capture=' + $info)
            Write-Output ('path=' + $out)
        }
        'region' {
            if (-not $out) { Fail 'region needs VG_OUT' }
            if ($w -le 0 -or $h -le 0) { Fail 'region needs VG_W and VG_H' }
            $info = [VisualGrab]::CaptureRegion($out, $x, $y, $w, $h, $maxPx)
            Write-Output ('capture=' + $info)
            Write-Output ('path=' + $out)
        }
        'window' {
            if (-not $out) { Fail 'window needs VG_OUT' }
            if ($handle -eq 0) { Fail 'window needs VG_HANDLE' }

            # A minimized window cannot be captured (its rect is off-screen), so
            # restore it first and put it back afterwards: state we changed only
            # to take a screenshot must not be left behind on the user's desktop.
            # Only restore what we actually changed, hence the return code.
            $restoreMin = ($env:VG_RESTOREMINIMIZED -ne '0')
            $unminimized = 0
            if ($restoreMin) {
                $unminimized = [VisualGrab]::RestoreWindow($handle)
                # -2 means every strategy failed. Say so plainly instead of letting
                # CaptureWindow throw a vague "window is minimized".
                if ($unminimized -eq -2) {
                    Fail 'target window is minimized and could not be restored by any strategy (async / sync / foreground); bring it up manually or capture the screen instead'
                }
                if ($unminimized -eq -1) { Fail 'target window no longer exists' }
            }
            # Diagnostics must be printed BEFORE the capture: an exception there
            # skips every later Write-Output.
            Write-Output ('unminimized=' + $unminimized)

            $original = [VisualGrab]::ForegroundHandle()
            $raiseLog = ''
            $restoreNeeded = ($raise -and $original -ne 0 -and $original -ne $handle)
            if ($raise) {
                $raiseLog = [VisualGrab]::Activate($handle)
                Start-Sleep -Milliseconds 500
                # Report visibility AFTER the raise: the caller's pre-raise sample
                # is 0/9 by definition (that is why it raised), so quoting it next
                # to a successful capture reads as if the capture were occluded.
                Write-Output ('coverageRaised=' + [VisualGrab]::SampleCoverage($handle))
            }
            try {
                $info = [VisualGrab]::CaptureWindow($out, $handle, $maxPx)
                # A window we just un-minimized may not have repainted yet, and the
                # capture then comes out uniformly blank (all white). IsIconic only
                # says the flag flipped -- it says nothing about painted pixels.
                # Take one more shot before reporting a blank frame as the result.
                if ($unminimized -ge 1 -and $info -match 'blank=1') {
                    Start-Sleep -Milliseconds 700
                    $retry = [VisualGrab]::CaptureWindow($out, $handle, $maxPx)
                    if ($retry -notmatch 'blank=1') {
                        $info = $retry
                        Write-Output 'repainted=1'
                    } else {
                        Write-Output 'repainted=0'
                    }
                }
            } finally {
                if ($restoreNeeded) {
                    $restoreLog = [VisualGrab]::Activate($original)
                    Start-Sleep -Milliseconds 300
                    Write-Output ('restoreLog=' + $restoreLog)
                    Write-Output ('restored=' + [int]([VisualGrab]::ForegroundHandle() -eq $original))
                } else {
                    # Target was already foreground (or raise was not requested):
                    # focus never moved, nothing to restore. Still report it, so
                    # callers can tell "not needed" apart from "restore failed".
                    Write-Output ('restoreLog=not-needed')
                    Write-Output ('restored=1')
                }
                if ($unminimized -ge 1) {
                    Start-Sleep -Milliseconds 200
                    Write-Output ('reminimized=' + [VisualGrab]::MinimizeWindow($handle))
                }
            }
            if ($raiseLog) { Write-Output ('raiseLog=' + $raiseLog) }
            Write-Output ('raised=' + [int]$raise)
            Write-Output ('restoreNeeded=' + [int]$restoreNeeded)
            Write-Output ('capture=' + $info)
            Write-Output ('path=' + $out)
        }
        default { Fail "unknown mode '$mode'" }
    }
} catch {
    Fail $_.Exception.Message
}
