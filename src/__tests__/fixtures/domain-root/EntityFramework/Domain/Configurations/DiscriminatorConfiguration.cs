using TrainerRoad.Server.Domain;

namespace TrainerRoad.Server.EntityFramework.Domain.Configurations
{
    public class BaseTeamConfiguration : BaseEntityTypeConfiguration<BaseTeam>
    {
        public BaseTeamConfiguration()
        {
            Map(m =>
            {
                m.ToTable("Team");
                m.Requires("Type").HasValue(0);
            });

            HasKey(t => t.Id);

            Ignore(t => t.Members);
            Ignore(t => t.DisplayName);

            HasMany(t => t.Plans)
                .WithMany()
                .Map(m => m.ToTable("TeamPlan").MapLeftKey("TeamId").MapRightKey("PlanId"));
        }
    }
}
