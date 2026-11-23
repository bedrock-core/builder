import com.google.gson.GsonBuilder;
import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.SharedConstants;
import net.minecraft.client.model.geom.LayerDefinitions;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;
import org.joml.Vector3fc;

/** Extract registry defaults and model definitions from the pinned, unobfuscated Java client. */
public final class AssetExtract {
    private static Map<String, Object> object(Object... pairs) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) result.put((String) pairs[i], pairs[i + 1]);
        return result;
    }

    private static Object field(Object source, String name) throws ReflectiveOperationException {
        Field field = source.getClass().getDeclaredField(name);
        field.setAccessible(true);
        return field.get(source);
    }

    private static Number number(Object source, String name) throws ReflectiveOperationException {
        try { return (Number) source.getClass().getMethod(name).invoke(source); }
        catch (NoSuchMethodException missing) { return (Number) field(source, name); }
    }

    private static List<Float> vector(Vector3fc value) { return List.of(value.x(), value.y(), value.z()); }

    private static Object part(Object source) throws ReflectiveOperationException {
        Object pose = field(source, "partPose");
        Map<String, Object> transform = object(
            "offset", List.of(number(pose, "x"), number(pose, "y"), number(pose, "z")),
            "rotation", List.of(number(pose, "xRot"), number(pose, "yRot"), number(pose, "zRot")));
        List<Number> scale = List.of(number(pose, "xScale"), number(pose, "yScale"), number(pose, "zScale"));
        if (scale.stream().anyMatch(n -> n.floatValue() != 1)) transform.put("scale", scale);
        List<Object> cubes = new ArrayList<>();
        for (Object cube : (List<?>) field(source, "cubes")) {
            Object uv = field(cube, "texCoord"), growth = field(cube, "grow");
            Map<String, Object> value = object("origin", vector((Vector3fc) field(cube, "origin")),
                "size", vector((Vector3fc) field(cube, "dimensions")), "uv", List.of(number(uv, "u"), number(uv, "v")));
            List<Number> grow = List.of(number(growth, "growX"), number(growth, "growY"), number(growth, "growZ"));
            if (grow.stream().anyMatch(n -> n.floatValue() != 0)) value.put("grow", grow);
            if ((Boolean) field(cube, "mirror")) value.put("mirror", true);
            Object texScale = field(cube, "texScale");
            List<Number> uvScale = List.of(number(texScale, "u"), number(texScale, "v"));
            if (uvScale.stream().anyMatch(n -> n.floatValue() != 1)) value.put("uvScale", uvScale);
            var visibleFaces = (java.util.Set<?>) field(cube, "visibleFaces");
            if (visibleFaces.size() != 6) value.put("visibleFaces", visibleFaces.stream().map(Object::toString).sorted().toList());
            cubes.add(value);
        }
        Map<String, Object> children = new TreeMap<>();
        for (var child : ((Map<?, ?>) field(source, "children")).entrySet()) children.put((String) child.getKey(), part(child.getValue()));
        return object("pose", transform, "cubes", cubes, "children", children);
    }

    private static <T extends Comparable<T>> String value(Property<T> property, BlockState state) {
        return property.getName(state.getValue(property));
    }

    private static <T extends Comparable<T>> List<String> values(Property<T> property) {
        return property.getPossibleValues().stream().map(property::getName).toList();
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 2) throw new IllegalArgumentException("AssetExtract <version> <output.json>");
        SharedConstants.tryDetectVersion();
        if (!SharedConstants.getCurrentVersion().id().equals(args[0])) throw new IllegalArgumentException("Client version does not match the requested extraction");
        Bootstrap.bootStrap();
        Map<String, Object> blocks = new TreeMap<>();
        for (Block block : BuiltInRegistries.BLOCK) {
            var definition = block.getStateDefinition();
            Map<String, Object> properties = new TreeMap<>();
            for (Property<?> property : definition.getProperties()) properties.put(property.getName(), values(property));
            Map<String, Object> defaults = new TreeMap<>();
            for (Property<?> property : definition.getProperties()) defaults.put(property.getName(), value(property, block.defaultBlockState()));
            int index = 0;
            for (Property<?> property : definition.getProperties()) {
                List<String> domain = values(property);
                index = index * domain.size() + domain.indexOf(defaults.get(property.getName()));
            }
            Map<String, Object> record = object("default", index);
            if (!properties.isEmpty()) record.put("properties", properties);
            blocks.put(BuiltInRegistries.BLOCK.getKey(block).toString(), record);
        }
        Map<String, Map<String, Object>> models = new TreeMap<>();
        for (var entry : LayerDefinitions.createRoots().entrySet()) {
            String id = entry.getKey().model().toString(), layer = entry.getKey().layer();
            Object definition = entry.getValue(), material = field(definition, "material"), mesh = field(definition, "mesh");
            Object data = object("texture", List.of(number(material, "xTexSize"), number(material, "yTexSize")), "root", part(field(mesh, "root")));
            if (models.computeIfAbsent(id, ignored -> new TreeMap<>()).put(layer, data) != null) throw new IllegalStateException("Duplicate model layer " + id + "/" + layer);
        }
        var result = object("schemaVersion", 1, "javaVersion", args[0], "blocks", blocks, "models", models);
        Files.writeString(Path.of(args[1]), new GsonBuilder().disableHtmlEscaping().create().toJson(result) + "\n");
    }
}
