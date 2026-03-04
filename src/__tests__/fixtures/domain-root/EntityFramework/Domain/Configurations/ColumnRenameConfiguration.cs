using TrainerRoad.Server.Domain;

namespace TrainerRoad.Server.EntityFramework.Domain.Configurations
{
    public class CyclingActivityMlClassificationConfiguration : BaseEntityTypeConfiguration<CyclingActivityMlClassification>
    {
        public CyclingActivityMlClassificationConfiguration()
        {
            ToTable("WorkoutRecordMlClassification");
            HasKey(x => x.Id);

            Property(x => x.Type).HasColumnName("Classification");

            HasRequired(x => x.CyclingActivity)
                .WithMany(x => x.MlClassifications)
                .HasForeignKey(x => x.CyclingActivityId);
        }
    }
}
