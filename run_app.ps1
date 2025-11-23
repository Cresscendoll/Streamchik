param(
    [string]$Command = "start"
)

Set-Location "D:\streamchik102"

switch ($Command) {
    "start" { npm start }
    "dist" { npm run dist }
    default { npm run $Command }
}
