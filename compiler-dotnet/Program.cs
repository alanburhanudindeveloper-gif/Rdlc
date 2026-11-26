using System.Text.Json;
using ReportGen.Compiler;
using ReportGen.Compiler.Models;

if (args.Length < 2)
{
    Console.Error.WriteLine("Usage: dotnet run --project compiler-dotnet -- <layout_ir.json> <output.rdlc>");
    return 1;
}

string inputJsonPath = args[0];
string outputRdlcPath = args[1];

if (!File.Exists(inputJsonPath))
{
    Console.Error.WriteLine($"Input layout IR file not found: {inputJsonPath}");
    return 2;
}

string json = await File.ReadAllTextAsync(inputJsonPath);
var ir = JsonSerializer.Deserialize<LayoutIrDocument>(json, new JsonSerializerOptions
{
    PropertyNameCaseInsensitive = true
});

if (ir is null || ir.Pages.Count == 0)
{
    Console.Error.WriteLine("Invalid or empty layout_ir.json");
    return 3;
}

var builder = new RdlcBuilder();
var result = builder.Build(ir);

string? outDir = Path.GetDirectoryName(Path.GetFullPath(outputRdlcPath));
if (!string.IsNullOrEmpty(outDir))
{
    Directory.CreateDirectory(outDir);
}

await File.WriteAllTextAsync(outputRdlcPath, result.RdlcXml);

Console.WriteLine($"Compiled {result.SourcePageCount} page(s) -> {result.Tablixes.Count} outer Tablix(es).");
Console.WriteLine($"Page parity satisfied: {result.PageParitySatisfied}");

if (result.ValidationErrors.Count > 0)
{
    foreach (var err in result.ValidationErrors)
    {
        Console.Error.WriteLine($"[RDLC-2008-ERROR] {err}");
    }
    return 4;
}

return 0;
